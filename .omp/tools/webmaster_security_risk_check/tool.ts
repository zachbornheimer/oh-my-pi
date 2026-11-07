import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { InventoryDeps } from "./asset_inventory.ts";
import type { ResearchDeps } from "./advisory_sources.ts";
import { type Machine, type ProcessResult, type RunProcess, systemMachine } from "./machine.ts";
import { type Exec, type ModelStep, ompModelStep, withHeartbeat } from "./omp_model.ts";
import { runRiskCheck } from "./risk_check.ts";

/** The longest one process (an SSH session) may run before it is stopped and recorded as not run. */
export const COMMAND_TIMEOUT_MS = 300_000;

export interface RiskToolDeps {
  /** The machine the assets and facts are read through; the factory builds the real one from `pi.exec`. */
  machine?: (signal: AbortSignal | undefined) => Machine;
  run?: RunProcess;
  /** The model step; the factory spawns `omp -p` through `pi.exec`. */
  model?: ModelStep;
  research?: ResearchDeps;
  inventory?: InventoryDeps;
  environment?: Readonly<Record<string, string | undefined>>;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Take a newly reported security problem in plain words (a domain such as `sshhole.com`, a URL, a CVE id, or a sentence) and say which of the owner's servers and sites it puts at risk. "
  + "Use it when an alert or advisory arrives and you need to know which servers and sites are affected, not for a single known host (webmaster_security_inventory reads raw facts). "
  + "Input: `{\"text\":\"CVE-2026-1234\"}`, optionally `servers`/`sites` (names) to check only those. "
  + "It reads the advisory (the pages, NVD, OSV, Red Hat and Ubuntu records the words point at, or a web search of them; with `OPENROUTER_API_KEY` set the search is OpenRouter's billed web plugin, else DuckDuckGo), lists every server in `~/.ssh/config` and every site file under `WEBMASTER_SITES_DIR`, reads fixed read-only facts from each over SSH (`WEBMASTER_SECURITY_SERVER=0` switches SSH off) and HTTP, and makes billed `omp -p` model calls: one to profile the advisory, one per applicable asset to decide its conditions against quoted facts. Verdicts come from code, never the model's guess. "
  + "Result: `{advisory, sources, headline, counts, assets, findings, unmeasured}`; each asset is `affected`, `not_affected`, `unmeasured` (a fact could not be read: never counted safe) or `not_applicable`, with the conditions and the fact line each quotes. It never fixes, changes, restarts or messages anything; the compromise indicators it reports are advice it does not run. It fails when nothing could be read about the advisory or no asset is listed.";

/** The real runner: omp's `exec`, a stopped command recorded as code -1, a cancelled run thrown. */
export function runWithPi(pi: Pi): RunProcess {
  return async (command, args, signal) => {
    const result = await pi.exec(command, [...args], { cwd: pi.cwd, timeout: COMMAND_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    const out: ProcessResult = {
      code: result.killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.killed ? `${result.stderr}\nstopped after ${COMMAND_TIMEOUT_MS} ms`.trim() : result.stderr,
    };
    return out;
  };
}

export function makeTool(pi: Pi, deps: RiskToolDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  const model: ModelStep = deps.model ?? ompModelStep(pi.exec as unknown as Exec);
  return {
    name: "webmaster_security_risk_check",
    label: "Security risk check",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().min(1).describe("The advisory in the owner's words: a domain (`sshhole.com`), a URL, a CVE id, or a sentence naming any of them."),
      servers: z.array(z.string()).nullable().optional().describe(
        "Check only these servers, by name; with `sites`, only the ones named in either. Every server and site when both are omitted.",
      ),
      sites: z.array(z.string()).nullable().optional().describe("Check only these sites, by name."),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string; servers?: string[] | null; sites?: string[] | null },
      onUpdate: Parameters<typeof withHeartbeat>[0],
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      const text = params.text.trim();
      if (text === "") throw new Error('the advisory is needed, such as "sshhole.com" or "CVE-2026-1234"');
      const environment = deps.environment;
      const machine =
        deps.machine?.(signal) ??
        systemMachine(run, { ...(signal === undefined ? {} : { signal }), ...(environment === undefined ? {} : { environment }) });
      const result = await withHeartbeat(onUpdate, "checking the advisory against every server and site", () =>
        runRiskCheck(
          { text, servers: params.servers ?? undefined, sites: params.sites ?? undefined },
          {
            machine,
            model,
            ...(deps.research === undefined ? {} : { research: deps.research }),
            ...(deps.inventory === undefined ? {} : { inventory: deps.inventory }),
            ...(signal === undefined ? {} : { signal }),
          },
        ),
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
