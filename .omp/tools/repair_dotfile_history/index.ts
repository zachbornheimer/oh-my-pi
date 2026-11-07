import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type RepairOutput, type RepairPorts, repairDotfileHistory } from "./repair.ts";

/**
 * Native `repair_dotfile_history` custom tool: a port of the Mastra capability of the same name. Self-contained: no
 * Mastra, no gateway, and no shell (every process is an argument list through `pi.exec`).
 */

const HEARTBEAT_MS = 15_000;
/** The mise history store this machine repairs: mise's bare git mirror of the dotfiles. */
const STORE_RELATIVE = join(".local", "state", "mise", "history", "repo.git");

export const DESCRIPTION =
  "Remove local-only plaintext versions of encrypted dotfile paths from the mise history store (`~/.local/state/mise/history/repo.git`) so `mise dot sync` can publish again. "
  + "`{\"paths\":[\"~/.local/bin/_llm\"],\"dryRun\":true}`: `paths` are live files under the home directory (`~/...` or absolute) or store paths (`home/...`); `dryRun` is REQUIRED, with no default. "
  + "ALWAYS call with `dryRun:true` first and call `dryRun:false` only when the user asked for the real repair. "
  + "Guards, with nothing touched: it refuses when plaintext for a path is reachable from `origin/setup` (that needs a force-push) and when a path has no local plaintext commit; it NEVER passes `--allow-plaintext-history`. "
  + "Dry run: bundles and copies the store into a private temp directory, rewrites `main` in the copy with `git filter-branch`, and verifies no plaintext remains and `origin/setup` and `backup-*` refs are unchanged. "
  + "Real run, additionally: stops the two `dev.mise.mise-history*` launchd services and confirms the watcher is gone, swaps the verified copy in (original kept as `repo.git.bak-<time>`), runs `mise dot save` per path and checks the store holds an encrypted blob for each, runs `mise dot sync` (success means no `cannot publish`), and restarts the services and confirms the watcher. "
  + "Any failure before the publish restores the original store and the services, then fails; a failure after a successful publish keeps the repaired store and says so. "
  + "Result: `{dry_run, old_main, new_main, origin_tip_before, origin_tip_after, offenders_removed, backups:{bundle, copy, bak_dir}, services_stopped, services_restored, publish_succeeded, remaining_offenders}`; after a real publish `origin_tip_after` is the new published tip. "
  + "A real run rewrites git history, stops services and pushes to the sync remote; takes minutes.";

type ToolApi = Parameters<CustomToolFactory>[0];
type Update = (partial: { content: { type: "text"; text: string }[]; details?: unknown }) => void;

/** The test seam: ports other than `exec`, which production takes from `pi`. */
export type PortOverrides = Partial<Omit<RepairPorts, "exec" | "progress">> & { exec?: RepairPorts["exec"] };

/** The real ports: `pi.exec`, the real home and store. */
export function productionPorts(pi: ToolApi, overrides: PortOverrides = {}): Omit<RepairPorts, "progress"> {
  const home = overrides.home ?? homedir();
  return {
    exec:
      overrides.exec
      ?? (async (command, args, options) =>
        pi.exec(command, [...args], { cwd: options?.cwd ?? pi.cwd, timeout: options?.timeoutMs, signal: options?.signal })),
    home,
    storeDir: overrides.storeDir ?? join(home, STORE_RELATIVE),
    tmpRoot: overrides.tmpRoot ?? tmpdir(),
    uid: overrides.uid ?? process.getuid?.() ?? 0,
    now: overrides.now ?? (() => new Date()),
    sleep:
      overrides.sleep
      ?? ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      }),
    ...(overrides.watchdogLabel === undefined ? {} : { watchdogLabel: overrides.watchdogLabel }),
    ...(overrides.historyLabel === undefined ? {} : { historyLabel: overrides.historyLabel }),
  };
}

/** The text the model reads: what happened in one line, then the full report. */
export function renderReport(output: RepairOutput): string {
  const removed = output.offenders_removed.map((entry) => `${entry.path} (${entry.plaintext_commits} plaintext commit(s))`).join(", ");
  const head = output.dry_run
    ? `DRY RUN: the rewrite of ${removed} verified in ${output.backups.copy}; nothing was swapped, saved, published or stopped.`
    : `REPAIRED ${removed}: published, services restored. The original store is at ${output.backups.bak_dir}.`;
  return `${head}\n${JSON.stringify(output)}`;
}

/** Build the tool; `overrides` is the test seam (store, home, exec, clock). Production passes none. */
export function buildTool(pi: ToolApi, overrides: PortOverrides = {}) {
  const z = pi.zod;
  return {
    name: "repair_dotfile_history",
    label: "Repair Dotfile History",
    description: DESCRIPTION,
    parameters: z.object({
      paths: z
        .array(z.string().min(1))
        .min(1)
        .describe("Dotfiles to repair: `~/.local/bin/_llm`, an absolute path under home, or a store path `home/.local/bin/_llm`. One file each, no globs."),
      dryRun: z
        .boolean()
        .describe("REQUIRED. `true`: rehearse in a copy and report, changing nothing live. `false`: the real repair (swaps the store, saves, publishes, restarts services)."),
    }),

    async execute(
      _toolCallId: string,
      params: { paths: string[]; dryRun: boolean },
      onUpdate: Update | undefined,
      _ctx: unknown,
      signal: AbortSignal | undefined,
    ) {
      const began = Date.now();
      let step = "starting";
      const beat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text", text: `repair_dotfile_history: ${step} (${Math.round((Date.now() - began) / 1000)} s)` }],
          details: { status: "running", step },
        });
      }, HEARTBEAT_MS);
      try {
        const ports: RepairPorts = {
          ...productionPorts(pi, overrides),
          progress: (message) => {
            step = message;
            onUpdate?.({ content: [{ type: "text", text: `repair_dotfile_history: ${message}` }], details: { status: "running", step } });
          },
        };
        const output = await repairDotfileHistory({ paths: params.paths, dryRun: params.dryRun }, ports, signal);
        return { content: [{ type: "text" as const, text: renderReport(output) }], details: output };
      } finally {
        clearInterval(beat);
      }
    },
  };
}

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
