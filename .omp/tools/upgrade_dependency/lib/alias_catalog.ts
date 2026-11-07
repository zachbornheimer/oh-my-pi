// Port of agentmux internal/depupgrade/aliases_catalog.go: the aliases a build tool applies without the
// repository saying so, and the packages exempt from the facade rule. The catalog is embedded data
// (Go's `//go:embed aliases.yaml`); here it is the constant EMBEDDED_ALIASES below.

/** manifestFileName is the manifest whose declared names the catalog reads. */
const MANIFEST_FILE_NAME = "package.json";

/** manifestDependencySections are the package.json maps that declare a name. */
const MANIFEST_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** AliasRule says that a repository declaring every name in when_manifest_has imports package under the name alias. */
export interface AliasRule {
  when_manifest_has: string[];
  alias: string;
  package: string;
  evidence: string;
}

/** AliasCatalog is the aliases a build tool applies without the repository saying so, and the packages exempt from the facade rule. */
export interface AliasCatalog {
  aliases: AliasRule[];
  facade_exempt: string[];
}

function normalizeCatalog(parsed: unknown): AliasCatalog {
  const record = (parsed ?? {}) as { aliases?: unknown; facade_exempt?: unknown };
  const aliases = Array.isArray(record.aliases) ? record.aliases : [];
  return {
    aliases: aliases.map((entry) => {
      const rule = (entry ?? {}) as {
        when_manifest_has?: unknown;
        alias?: unknown;
        package?: unknown;
        evidence?: unknown;
      };
      return {
        when_manifest_has: Array.isArray(rule.when_manifest_has) ? rule.when_manifest_has.map(String) : [],
        alias: typeof rule.alias === "string" ? rule.alias : "",
        package: typeof rule.package === "string" ? rule.package : "",
        evidence: typeof rule.evidence === "string" ? rule.evidence : "",
      };
    }),
    facade_exempt: Array.isArray(record.facade_exempt) ? record.facade_exempt.map(String) : [],
  };
}

/** ParseAliasCatalog checks a catalog value, refusing an entry that names no manifest, alias or package. */
export function ParseAliasCatalog(value: unknown): AliasCatalog {
  const catalog = normalizeCatalog(value);
  catalog.aliases.forEach((rule, index) => {
    if (rule.alias === "" || rule.package === "" || rule.when_manifest_has.length === 0) {
      throw new Error(`depupgrade: alias catalog entry ${index + 1} needs when_manifest_has, alias, and package`);
    }
  });
  return catalog;
}

/** ManifestNames is every package name a package.json declares. */
export function ManifestNames(raw: string): Set<string> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`depupgrade: decode ${MANIFEST_FILE_NAME}: ${(error as Error).message}`, { cause: error });
  }
  const names = new Set<string>();
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return names;
  for (const section of MANIFEST_DEPENDENCY_SECTIONS) {
    const deps = (manifest as Record<string, unknown>)[section];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

/** Applied is the aliases of `pkg` that hold for a repository declaring `manifest`, with the evidence for each. */
export function Applied(
  catalog: AliasCatalog,
  pkg: string,
  manifest: Set<string>,
): { aliases: string[]; evidence: string[] } {
  const aliases: string[] = [];
  const evidence: string[] = [];
  for (const rule of catalog.aliases) {
    if (rule.package !== pkg || aliases.includes(rule.alias)) continue;
    if (rule.when_manifest_has.some((name) => !manifest.has(name))) continue;
    aliases.push(rule.alias);
    evidence.push(rule.evidence);
  }
  return { aliases, evidence };
}

/** Exempts reports whether the package skips the facade rule. */
export function Exempts(catalog: AliasCatalog, pkg: string): boolean {
  return catalog.facade_exempt.includes(pkg);
}

let cached: AliasCatalog | undefined;

/**
 * The embedded catalog (aliases.yaml in Mastra). An entry says that when a repository's manifest declares every name
 * in when_manifest_has, files that import `alias` are importing `package`, so they count as importers of the bumped
 * package. facade_exempt lists packages that skip the facade rule because many files may import them directly; it is
 * empty on purpose: which packages belong there is the repository owner's decision, not a default.
 */
export const EMBEDDED_ALIASES: AliasCatalog = {
  aliases: [
    {
      when_manifest_has: ["expo", "react-native-web"],
      alias: "react-native",
      package: "react-native-web",
      evidence: "Expo web resolves react-native to react-native-web",
    },
  ],
  facade_exempt: [],
};

/** The embedded catalog, checked once (aliases_catalog.go loadEmbeddedAliases). */
export function loadEmbeddedAliases(): AliasCatalog {
  cached ??= ParseAliasCatalog(EMBEDDED_ALIASES);
  return cached;
}
