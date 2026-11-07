import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** omp's own `pi.zod` (omptype): the fork's package when this directory sits in `.omp/tools/`, else the local checkout. */
export async function loadZod(): Promise<unknown> {
  const candidates = [
    fileURLToPath(new URL("../../../packages/omptype/src/zod.ts", import.meta.url)),
    join(homedir(), "Developer/Personal/oh-my-pi/packages/omptype/src/zod.ts"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`omptype zod.ts not found in: ${candidates.join(", ")}`);
  // The path is chosen at run time (fork layout or local checkout), so a static import cannot name it.
  return ((await import(found)) as { z: unknown }).z;
}
