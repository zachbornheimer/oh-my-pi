import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { withHeartbeat, type Update } from "./heartbeat";
import { livePorts } from "./live";
import { normalizeOnly } from "./only";
import { runJob } from "./run";
import { JOB_NAMES, type JobName, type RunRecord, type SchedulePorts } from "./types";

type Pi = Parameters<CustomToolFactory>[0];
type Exec = Parameters<typeof livePorts>[0]["exec"];

export const DESCRIPTION =
  "Run one scheduled webmaster job over the site profiles and return its run record. Use it for the hourly, daily, Monday and Monday-reminder runs; to check one site, use the `webmaster_security_*` tools. "
  + "Input: `{\"job\":\"uptime\"|\"daily\"|\"weekly\"|\"weekly-reminder\",\"only\":[\"bpp\"]}`. `only` limits the run to those profile names (case-sensitive, trimmed, at least one): `[]` or a blank name is refused; omitted or null runs every site. Other sites are recorded `skipped`; a name with no profile makes the run `incomplete`. Profiles are `$WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`); state is `$WEBMASTER_STATE_DIR` (default `~/.local/state/webmaster`). "
  + "Each site runs under its own `schedule-<job>-<site>.lock` there: a live holder is `refused`, a dead pid's lock is reclaimed. "
  + "NATIVE LIMIT: the diagnose, maintain and notify-decision steps need Mastra workflows this tool lacks (they fail with `BLOCKED: ...`), and digest and apply are `not-wired`, so `uptime`, `daily` and `weekly` end `incomplete`, file no tickets and send no alert. Only `weekly-reminder` completes. "
  + "Writes `<job>.last.json`, appends `<job>.runs.jsonl`, and `weekly-reminder` raises a macOS notification (non-macOS is an error). "
  + "Result: `{job,startedAt,finishedAt,status:running|complete|incomplete,sites:[{site,status,stages,reportPath,coverage?}],notes}` as JSON.";

export interface ScheduleToolDeps {
  /** Overrides any live port; each missing port stays live. Tests inject fakes here. */
  ports?: Partial<SchedulePorts>;
  /** Replaces the environment the live ports read directories from. */
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: string;
  /** Heartbeat interval; tests shorten it. */
  heartbeatMs?: number;
}

/** The one-line summary after the record JSON. */
export function summaryOf(record: RunRecord): string {
  const ran = record.sites.filter((site) => site.status !== "skipped");
  const unclean = ran.filter((site) => site.status !== "ok").length;
  return `${record.job}: ${record.status}; ${ran.length} site(s) run, ${unclean} not ok, ${record.sites.length - ran.length} skipped.`;
}

export function makeTool(pi: Pi, deps: ScheduleToolDeps = {}) {
  const z = pi.zod;
  const exec = pi.exec as unknown as Exec;
  const parameters = z.object({
    job: z.enum([...JOB_NAMES]).describe("One of `uptime` (hourly), `daily`, `weekly` (Monday check) or `weekly-reminder`."),
    only: z.array(z.string().min(1)).min(1).nullable().optional().describe(
      "Profile names to run, such as `[\"bpp\"]`; at least one, none blank. Omit or null for every site. `[]` is refused.",
    ),
  });
  return {
    name: "webmaster_schedule_run",
    label: "Webmaster scheduled run",
    description: DESCRIPTION,
    parameters,
    async execute(
      _toolCallId: string,
      params: { job: JobName; only?: string[] | null },
      onUpdate: Update | undefined,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const parsed = parameters.safeParse(params);
      if (!parsed.success) throw new Error(`webmaster_schedule_run: invalid input: ${parsed.error.message}`);
      const { job, only } = parsed.data as { job: JobName; only?: string[] | null };
      const wanted = only === undefined || only === null ? undefined : normalizeOnly(only);
      const live = livePorts({
        exec,
        ...(deps.env === undefined ? {} : { env: deps.env }),
        ...(deps.home === undefined ? {} : { home: deps.home }),
        ...(deps.platform === undefined ? {} : { platform: deps.platform }),
        ...(signal === undefined ? {} : { signal }),
      });
      const ports: SchedulePorts = { ...live, ...deps.ports };
      const record = await withHeartbeat(
        onUpdate,
        `running ${job}${wanted === undefined ? "" : ` for ${wanted.join(", ")}`}`,
        () => runJob(job, ports, wanted, signal === undefined ? {} : { signal }),
        deps.heartbeatMs,
      );
      return {
        content: [{ type: "text" as const, text: `${JSON.stringify(record, null, 2)}\n${summaryOf(record)}` }],
        details: record,
      };
    },
  };
}
