import {
  contentDirectories,
  type InspectCommand,
  type InspectOutput,
  type WordpressInspect,
} from "./inspect.ts";

/**
 * Reading what one of the inspection's commands printed. Plumbing for the checks that judge it: a command that did not
 * run, or printed something unreadable, leaves its check unmeasured, never passing. Port of Mastra's
 * `webmaster/security/wp_cli.ts`.
 */

export type MeasuredInspect = Extract<WordpressInspect, { status: "measured" }>;

/** Exit codes that mean the command did not run at all: ssh failed, the binary is missing, it could not start. */
const DID_NOT_RUN = new Set([-1, 126, 127, 255]);
/** `find` exits 1 when some directories were unreadable; what it printed for the rest still counts. */
export const FIND_PARTLY_READ = 1;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The command's output when it ran, else why the check cannot judge it. */
export function ranOutput(
  inspect: MeasuredInspect,
  command: InspectCommand,
): InspectOutput | { readonly unmeasured: string } {
  const output = inspect.outputs.find((each) => each.command === command);
  if (output === undefined) return { unmeasured: `the inspection did not run \`${command}\`` };
  if (DID_NOT_RUN.has(output.code)) {
    return { unmeasured: `\`${output.command_line}\` did not run (exit ${output.code}): ${firstLine(output.stderr)}` };
  }
  return output;
}

/** Why an output could not be read. */
export const unreadable = (output: InspectOutput): { readonly unmeasured: string } => ({
  unmeasured: `could not read the output of \`${output.command_line}\`: ${firstLine(output.stdout || output.stderr)}`,
});

/** The rows a WP-CLI `--format=json` command printed, or undefined when it printed something else. */
export function jsonRows(stdout: string): Record<string, unknown>[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  } catch {
    return undefined;
  }
}

/** A row's field as text; empty when it is missing or not a string or number. */
export const field = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};

/** The non-empty lines a command printed. */
export const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** A `find` problem line is `find: '<path>': <reason>`, with the quotes some `find`s leave out. */
const FIND_PROBLEM =
  /^find: ['"\u2018]?(.+?)['"\u2019]?: (No such file or directory|Permission denied|Not a directory)$/;

/**
 * The output of a folder scan (`uploads_php`, `plugin_directories`, `theme_directories`) when it read the folder, else
 * why the check cannot judge it. `find` exits 1 both when the folder itself is missing and when it could not read
 * some deeper directory; only the second still counts as a reading. A folder `find` could not open is never a pass,
 * and neither is a scan that never ran because WordPress would not name its folders.
 */
export function scanOutput(
  inspect: MeasuredInspect,
  command: InspectCommand,
): InspectOutput | { readonly unmeasured: string } {
  const output = ranOutput(inspect, command);
  if ("unmeasured" in output) {
    const resolved = inspect.outputs.find((each) => each.command === "content_directories");
    const folders = resolved === undefined ? undefined : contentDirectories(resolved);
    return folders !== undefined && "unmeasured" in folders ? folders : output;
  }
  if (output.code !== 0 && output.code !== FIND_PARTLY_READ) return unreadable(output);
  // The folder is the first word after `find` that is not an option such as `-H`.
  const words = output.command_line.trim().split(/\s+/);
  const root = words.slice(words.indexOf("find") + 1).find((word) => !word.startsWith("-"));
  const rootProblem = output.stderr.split("\n").map((line) => FIND_PROBLEM.exec(line.trim())).find((match) =>
    match !== null && match[1] === root
  );
  if (rootProblem) return { unmeasured: `the folder \`${root}\` cannot be scanned: ${rootProblem[2]}` };
  return output;
}
