import { Applied, Exempts, loadEmbeddedAliases, ManifestNames } from "./alias_catalog.js";
import type { ConfigFiles } from "./ports.js";
import type { Package } from "./schemas.js";

// Port of agentmux internal/depupgrade/aliases.go: import aliases read from build configuration, merged
// with the ones the alias catalog supplies.

/** aliasConfigFiles are the build configurations, at the tree root, that can rename an import. */
const ALIAS_CONFIG_FILES = [
  "webpack.config.js",
  "webpack.config.cjs",
  "webpack.config.mjs",
  "webpack.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "tsconfig.json",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
];

/** aliasPair is a `'key': <value expression>` entry. */
const ALIAS_PAIR = /['"]([^'"\n]+)['"]\s*:\s*((?:\[\s*)?(?:['"][^'"\n]*['"]|[A-Za-z_.]+\([^)\n]*\)))/g;
const QUOTED_VALUE = /['"]([^'"]+)['"]/g;
const BARE_NAME = /^@?[\w.-]+(?:\/[\w.-]+)?$/;

/** aliasName turns a config key ("^react-native$", "react-native/*") into the bare module name it renames, or "" when it is not a module name. */
function aliasName(key: string): string {
  let name = key.replaceAll("^", "").replaceAll("$", "");
  if (name.endsWith("/(.*)")) name = name.slice(0, -"/(.*)".length);
  if (name.endsWith("/*")) name = name.slice(0, -"/*".length);
  if (!BARE_NAME.test(name) || name.startsWith(".")) return "";
  return name;
}

/** refersTo reports whether a config value expression points at the package: the bare name, a subpath of it, or its folder under node_modules. */
function refersTo(expr: string, pkg: string): boolean {
  for (const match of expr.matchAll(QUOTED_VALUE)) {
    const value = match[1]!.endsWith("/") ? match[1]!.slice(0, -1) : match[1]!;
    if (
      value === pkg
      || value.startsWith(pkg + "/")
      || value.endsWith("node_modules/" + pkg)
      || value.includes("node_modules/" + pkg + "/")
    ) {
      return true;
    }
  }
  return false;
}

/** DetectAliases reads text from the repository's build configuration and returns, per bumped package, the module names this repository imports it under. */
export function DetectAliases(configs: string[], packages: Package[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const config of configs) {
    for (const match of config.matchAll(ALIAS_PAIR)) {
      const name = aliasName(match[1]!);
      if (name === "") continue;
      for (const pkg of packages) {
        const existing = out.get(pkg.name) ?? [];
        if (name !== pkg.name && refersTo(match[2]!, pkg.name) && !existing.includes(name)) {
          out.set(pkg.name, [...existing, name]);
        }
      }
    }
  }
  return out;
}

/** packageAliases is every name a bumped package is imported under, why, and whether it is exempt from the facade rule. */
export interface PackageAliases {
  names: string[];
  evidence: string[];
  facadeExempt: boolean;
}

function join(root: string, name: string): string {
  return root.endsWith("/") ? root.slice(0, -1) + "/" + name : root + "/" + name;
}

async function detectedAliases(config: ConfigFiles, root: string, packages: Package[]): Promise<Map<string, string[]>> {
  const configs: string[] = [];
  for (const name of ALIAS_CONFIG_FILES) {
    try {
      configs.push(await config.readFile(join(root, name)));
    } catch {
      // A configuration this repository does not have names no aliases.
    }
  }
  return DetectAliases(configs, packages);
}

/**
 * catalogAliases is the catalog's aliases for each bumped package, by package. A repository without a
 * readable package.json has no manifest names, so no catalog alias applies and the gap is recorded.
 */
async function catalogAliases(
  config: ConfigFiles,
  root: string,
  packages: Package[],
  record: (message: string) => void,
): Promise<{ aliases: Map<string, string[]>; evidence: Map<string, string[]> }> {
  const aliases = new Map<string, string[]>();
  const evidence = new Map<string, string[]>();
  let raw: string;
  try {
    raw = await config.readFile(join(root, "package.json"));
  } catch {
    return { aliases, evidence };
  }
  let names: Set<string>;
  try {
    names = ManifestNames(raw);
  } catch (error) {
    record((error as Error).message);
    return { aliases, evidence };
  }
  const catalog = loadEmbeddedAliases();
  for (const pkg of packages) {
    const applied = Applied(catalog, pkg.name, names);
    aliases.set(pkg.name, applied.aliases);
    evidence.set(pkg.name, applied.evidence);
  }
  return { aliases, evidence };
}

/** packageAliases merges the aliases read from build configuration with those the alias catalog supplies, per bumped package. */
export async function packageAliases(
  config: ConfigFiles,
  root: string,
  packages: Package[],
  record: (message: string) => void,
): Promise<Map<string, PackageAliases>> {
  const catalog = loadEmbeddedAliases();
  const detected = await detectedAliases(config, root, packages);
  const fromCatalog = await catalogAliases(config, root, packages, record);
  const out = new Map<string, PackageAliases>();
  for (const pkg of packages) {
    const names = [...(detected.get(pkg.name) ?? [])];
    for (const alias of fromCatalog.aliases.get(pkg.name) ?? []) {
      if (!names.includes(alias)) names.push(alias);
    }
    out.set(pkg.name, {
      names,
      evidence: fromCatalog.evidence.get(pkg.name) ?? [],
      facadeExempt: Exempts(catalog, pkg.name),
    });
  }
  return out;
}
