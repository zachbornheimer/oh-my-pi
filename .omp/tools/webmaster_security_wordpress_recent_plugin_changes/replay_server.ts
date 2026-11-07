import type { InspectCommand, InspectOutput, ProcessResult, RunProcess } from "./inspect.ts";

/** Which of the inspection's fixed commands a remote command line is. */
export function commandNamed(remote: string): InspectCommand | undefined {
  // A PHP program travels as base64 on one line (`printf %s '<base64>' | base64 -d | wp eval-file -`): read it as PHP.
  const text = remote.replace(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/, (_, encoded: string) =>
    Buffer.from(encoded, "base64").toString(),
  );
  if (/(^|\s)find\s/.test(text)) {
    if (text.includes("-iname")) return "uploads_php";
    return /\/themes(\s|$)/.test(text) ? "theme_directories" : "plugin_directories";
  }
  if (text.includes("WP_PLUGIN_DIR")) return "content_directories";
  if (text.includes("wp_version_check")) return "update_discovery";
  if (text.includes("core verify-checksums")) return "core_checksums";
  if (text.includes("plugin verify-checksums")) return "plugin_checksums";
  if (text.includes(" user list ")) return "administrators";
  if (text.includes("plugin list") && text.includes("--fields=name,status")) return "must_use_plugins";
  if (text.includes("plugin list")) return "plugin_list";
  if (text.includes("theme list")) return "theme_list";
  if (text.includes("cron event list")) return "cron_events";
  if (text.endsWith(" core version")) return "core_version";
  return undefined;
}

export interface RecordedRun {
  readonly commandLine: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Which fixed command it was, when it is one. */
  readonly named: InspectCommand | undefined;
}

/**
 * A recorded server behind SSH: answers each fixed command with what a recording of that command printed, optionally
 * replaced per command. Never opens a connection; a command it cannot name prints nothing and fails with 127.
 */
export class ReplayServer {
  readonly runs: RecordedRun[] = [];

  constructor(
    private readonly recorded: readonly InspectOutput[],
    private readonly replaced: Partial<Record<InspectCommand, Partial<ProcessResult>>> = {},
  ) {}

  /** The fixed commands asked for, in order. */
  get asked(): (InspectCommand | undefined)[] {
    return this.runs.map((run) => run.named);
  }

  readonly run: RunProcess = async (command, args) => {
    const named = commandNamed(args.at(-1) ?? "");
    this.runs.push({ commandLine: [command, ...args].join(" "), command, args, named });
    if (named === undefined) return { code: 127, stdout: "", stderr: "unknown command" };
    const recorded = this.recorded.find((output) => output.command === named);
    const base: ProcessResult = recorded === undefined
      ? { code: 127, stdout: "", stderr: `no recording of ${named}` }
      : { code: recorded.code, stdout: recorded.stdout, stderr: recorded.stderr };
    return { ...base, ...this.replaced[named] };
  };
}
