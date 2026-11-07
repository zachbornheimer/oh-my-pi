import type { Machine } from "./machine.js";

/** Where omp loads custom tools from, under the home directory. */
export const TOOLS_DIRECTORY = ".omp/agent/tools";

/**
 * The tools installed in omp's tools directory that live under `namespace`, in the dotted spelling proposals use. A
 * tool is a directory or a top-level `<name>.ts` (not a `.test.ts`); omp tool names are snake_case, so
 * `webmaster_site_dns` under the namespace `webmaster` is `webmaster.site.dns`: the underscores after the namespace
 * become dots. This is the omp counterpart of the Mastra registry's capability names.
 */
export async function installedToolNames(machine: Machine, namespace: string): Promise<string[]> {
  const entries = await machine.listDirectory(`${machine.homeDirectory}/${TOOLS_DIRECTORY}`);
  const names = entries.flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) return [];
    if (entry.directory) return [entry.name];
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [entry.name.slice(0, -3)] : [];
  });
  const prefix = `${namespace}_`;
  return [...new Set(names.filter((name) => name.startsWith(prefix) && name.length > prefix.length))]
    .map((name) => `${namespace}.${name.slice(prefix.length).replace(/_/g, ".")}`);
}

/**
 * The registered names a run holds proposals against. A `registered` list the caller gives is used as it is (as the
 * Mastra completer kept one). Without one, a namespace lists the installed omp tools under it; without a namespace
 * nothing is registered, because the registered names only matter under a namespace.
 */
export async function registeredFor(
  given: readonly string[] | undefined,
  namespace: string | undefined,
  machine: Machine,
): Promise<string[]> {
  if (given !== undefined) return [...given];
  return namespace === undefined ? [] : installedToolNames(machine, namespace);
}
