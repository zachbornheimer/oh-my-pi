import type { Conventions } from "./conventions.js";
import type { PlannedFile } from "./locate_checks.js";
import { dirnameOf, stemOf } from "./paths.js";
import type { Design, Finding } from "./schemas.js";

/** Everything a draft of one file of the change needs to know. */
export interface DraftJob {
  readonly design: Design;
  readonly conventions: Conventions;
  readonly plan: readonly PlannedFile[];
  /** Numbers the design mentions, which modules must name. */
  readonly numbers: readonly string[];
  readonly known: ReadonlySet<string>;
  readonly changeSet: ReadonlySet<string>;
}

/** A file of the change as drafted, with what a revision needs to start from it. */
export interface DraftedSource {
  readonly file: PlannedFile;
  readonly content: string;
}

export interface Revision {
  readonly previous: string;
  readonly findings: readonly Finding[];
}

/** The name the files of the change belong to: the first module's directory when named after it, else its stem. */
export function ownerOf(plan: readonly PlannedFile[]): string {
  const first = plan.find((file) => file.role === "module");
  if (first === undefined) return "";
  const directory = dirnameOf(first.path).split("/").pop() ?? "";
  return directory === stemOf(first.path) ? directory : stemOf(first.path);
}
