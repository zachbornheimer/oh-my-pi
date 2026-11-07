import type { HostMachine } from "../machine.js";
import { MAX_REPLACED_NAMES, MAX_USAGE_FILES } from "./limits.js";

/** Where each name the design replaces is still used: the repo files that mention it as a whole word. */
export async function findUsages(
  machine: HostMachine,
  repo: string,
  names: readonly string[],
): Promise<{ name: string; files: string[] }[]> {
  return Promise.all(
    names.slice(0, MAX_REPLACED_NAMES).map(async (name) => {
      const searched = await machine.run("git", ["-C", repo, "grep", "-lw", "-F", "--", name]);
      const files = searched.code === 0 ? searched.stdout.split("\n").filter((line) => line !== "") : [];
      return { name, files: files.slice(0, MAX_USAGE_FILES) };
    }),
  );
}
