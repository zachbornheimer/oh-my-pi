import { dirnameOf, extensionOf, joinPath } from "./paths.js";

const RESOLVABLE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s+|\bimport\()\s*["'](\.{1,2}\/[^"']+)["']/g;

/** The relative module specifiers a TypeScript or JavaScript file imports. */
export function relativeImports(code: string): string[] {
  return [...code.matchAll(RELATIVE_IMPORT)].map(([, specifier]) => specifier!);
}

function normalise(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "." && segment !== "") segments.push(segment);
  }
  return segments.join("/");
}

/** The repo paths a specifier written in `fromFile` can mean: as written, with `.js` for `.ts`, or as a directory index. */
export function importTargets(fromFile: string, specifier: string): string[] {
  const target = normalise(joinPath(dirnameOf(fromFile), specifier));
  const extension = extensionOf(target);
  const stem = extension === "" ? target : target.slice(0, -extension.length);
  const swapped = RESOLVABLE_EXTENSIONS.map((candidate) => `${stem}${candidate}`);
  return [target, ...swapped, ...RESOLVABLE_EXTENSIONS.map((candidate) => `${target}/index${candidate}`)];
}

/** The file a specifier written in `fromFile` names, among `known`; undefined when none does. */
export function resolveImport(fromFile: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  return importTargets(fromFile, specifier).find((path) => known.has(path));
}
