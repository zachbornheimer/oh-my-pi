/**
 * Durable record of every software-factory run: append-only, one JSON line per event, at `$FACTORY_RUN_LEDGER` else
 * `~/.local/state/capability-replicas/factory-runs.jsonl` (the file the Mastra twin wrote, so one record covers both).
 * `run` lines open and close a run, `step` lines record a step's start and end; reading folds the lines, so the file
 * stays crash-safe and greppable.
 *
 * A run that dies without a closure does not hold its ticket busy forever: an opening record with no step event and no
 * closure within `RUN_LEASE_MS` is no longer live. Reading reports it `stale`, and the next run that opens heals the
 * stale records already on disk by appending their closure. A closure is written by the run's own `finally`; this module
 * registers no process-wide signal or crash handler, because it lives inside the omp process.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_LEDGER_PATH, RUN_LEASE_MS } from "./constants.js";

export type RunStatus = "running" | "success" | "failed" | "bailed" | "stale";

/** One factory run: a ticket through `software_factory_ticket`, or a sweep of tickets. */
export interface FactoryRun {
  readonly runId: string;
  readonly workflow: string;
  readonly ticket?: string;
  readonly status: RunStatus;
  readonly currentStep?: string;
  readonly outcome?: string;
  readonly error?: string;
  readonly prUrl?: string;
  readonly rounds?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/** One step transition inside a run: the timeline a person reads when a ticket stalls. */
export interface FactoryStepEvent {
  readonly runId: string;
  readonly step: string;
  readonly status: "started" | "succeeded" | "failed" | "skipped";
  readonly at: string;
  readonly detail?: string;
}

type LedgerLine =
  | ({ readonly kind: "run" } & Partial<FactoryRun> & { readonly runId: string })
  | ({ readonly kind: "step" } & FactoryStepEvent);

/** The ledger's public surface, which is what the factory ports carry: a caller (a test) injects its own. */
export interface FactoryLedger {
  readonly path: string;
  /** Recording problems since this ledger was made: recording never fails a ticket, but it never goes unsaid either. */
  readonly warnings: readonly string[];
  startRun(run: { runId: string; workflow: string; ticket?: string }): Promise<void>;
  startStep(runId: string, step: string): Promise<void>;
  endStep(runId: string, step: string, status: "succeeded" | "failed" | "skipped", detail?: string): Promise<void>;
  finishRun(
    runId: string,
    finish: { status: RunStatus; outcome?: string; error?: string; prUrl?: string; rounds?: number },
  ): Promise<void>;
  listRuns(filter?: { workflow?: string; status?: RunStatus; ticket?: string; limit?: number }): Promise<FactoryRun[]>;
  healStaleRuns(): Promise<string[]>;
  timeline(runId: string): Promise<FactoryStepEvent[]>;
}

export function ledgerPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.FACTORY_RUN_LEDGER?.trim();
  return override ? override : DEFAULT_LEDGER_PATH;
}

/** The message a human needs, from whatever a step threw. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** Only the optional fields a line actually carries, so a fold never overwrites a value with undefined. */
type RunFields = { -readonly [K in keyof FactoryRun]?: FactoryRun[K] };

function definedRunFields(line: Partial<FactoryRun>): RunFields {
  const fields: RunFields = {};
  if (line.ticket !== undefined) fields.ticket = line.ticket;
  if (line.currentStep !== undefined) fields.currentStep = line.currentStep;
  if (line.outcome !== undefined) fields.outcome = line.outcome;
  if (line.error !== undefined) fields.error = line.error;
  if (line.prUrl !== undefined) fields.prUrl = line.prUrl;
  if (line.rounds !== undefined) fields.rounds = line.rounds;
  if (line.finishedAt !== undefined) fields.finishedAt = line.finishedAt;
  return fields;
}

/** What a fold knows about one run once every line has been read. */
type FoldedRun = { run: FactoryRun; lastActivityAt: string };

function parseLines(raw: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const text of raw.split("\n")) {
    if (text.trim() === "") continue;
    try {
      lines.push(JSON.parse(text) as LedgerLine);
    } catch {
      // A half-written line is a crash artifact, not a reason to lose the rest of the file.
    }
  }
  return lines;
}

/** The runs as the lines read them, with the last thing each one recorded. */
function fold(lines: readonly LedgerLine[]): Map<string, FoldedRun> {
  const runs = new Map<string, FoldedRun>();
  for (const line of lines) {
    const previous = runs.get(line.runId);
    const at = line.kind === "step" ? line.at : undefined;
    const last = previous?.lastActivityAt;
    const lastActivityAt = at !== undefined && (last === undefined || at > last) ? at : (last ?? "");
    if (line.kind === "step") {
      if (previous !== undefined) runs.set(line.runId, { ...previous, lastActivityAt });
      continue;
    }
    const run: FactoryRun = {
      runId: line.runId,
      workflow: line.workflow ?? previous?.run.workflow ?? "unknown",
      status: line.status ?? previous?.run.status ?? "running",
      startedAt: line.startedAt ?? previous?.run.startedAt ?? new Date(0).toISOString(),
      ...definedRunFields(previous?.run ?? {}),
      ...definedRunFields(line),
    };
    const activity = [run.startedAt, run.finishedAt, lastActivityAt].reduce<string>(
      (newest, at2) => (at2 !== undefined && at2 > newest ? at2 : newest),
      "",
    );
    runs.set(line.runId, { run, lastActivityAt: activity });
  }
  return runs;
}

export class FactoryRunLedger implements FactoryLedger {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #warnings: string[] = [];

  constructor(path: string = ledgerPath(), options: { now?: () => Date; leaseMs?: number } = {}) {
    this.#path = path;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? RUN_LEASE_MS;
  }

  get path(): string {
    return this.#path;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  async #append(line: LedgerLine): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(line)}\n`, "utf8");
  }

  /** Opens a run, first healing the stale records already on disk. Recording never throws into the caller: a ledger failure must not fail a ticket. */
  async startRun(run: { runId: string; workflow: string; ticket?: string }): Promise<void> {
    await this.#safely(async () => {
      await this.healStaleRuns();
      const known = (await this.#lines()).some((line) => line.kind === "run" && line.runId === run.runId);
      if (known) return;
      await this.#append({ kind: "run", status: "running", startedAt: this.#now().toISOString(), ...run });
    });
  }

  async startStep(runId: string, step: string): Promise<void> {
    await this.#safely(async () => {
      await this.#append({ kind: "step", runId, step, status: "started", at: this.#now().toISOString() });
      // The run row carries the step in flight, so a list view answers "where is this ticket now?"
      await this.#append({ kind: "run", runId, currentStep: step });
    });
  }

  async endStep(runId: string, step: string, status: "succeeded" | "failed" | "skipped", detail?: string): Promise<void> {
    await this.#safely(() =>
      this.#append({ kind: "step", runId, step, status, at: this.#now().toISOString(), ...(detail === undefined ? {} : { detail }) })
    );
  }

  async finishRun(
    runId: string,
    finish: { status: RunStatus; outcome?: string; error?: string; prUrl?: string; rounds?: number },
  ): Promise<void> {
    await this.#safely(() => this.#append({ kind: "run", runId, finishedAt: this.#now().toISOString(), ...finish }));
  }

  async listRuns(filter: { workflow?: string; status?: RunStatus; ticket?: string; limit?: number } = {}): Promise<FactoryRun[]> {
    const now = this.#now().getTime();
    const all = [...(await this.#folded()).values()]
      .map(({ run, lastActivityAt }) =>
        run.status === "running" && now - Date.parse(lastActivityAt) > this.#leaseMs
          ? { ...run, status: "stale" as const }
          : run)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const kept = all.filter(
      (run) =>
        (filter.workflow === undefined || run.workflow === filter.workflow) &&
        (filter.status === undefined || run.status === filter.status) &&
        (filter.ticket === undefined || run.ticket === filter.ticket),
    );
    return filter.limit === undefined ? kept : kept.slice(0, filter.limit);
  }

  /**
   * Appends the closure every stale record on disk is missing, so no hand edit is ever needed. Answers the run ids it
   * healed; healing again heals nothing, and a run's own later ending still wins (the fold reads the last line).
   */
  async healStaleRuns(): Promise<string[]> {
    const healed: string[] = [];
    await this.#safely(async () => {
      const stale = [...(await this.#folded()).entries()]
        .filter(([runId, { run, lastActivityAt }]) =>
          run.status === "running" && this.#now().getTime() - Date.parse(lastActivityAt) > this.#leaseMs && runId)
        .map(([runId]) => runId);
      for (const runId of stale) {
        await this.#append({
          kind: "run",
          runId,
          status: "stale",
          finishedAt: this.#now().toISOString(),
          error: "no closure was written within the run lease; the run is no longer live",
        });
        healed.push(runId);
      }
    });
    return healed;
  }

  async timeline(runId: string): Promise<FactoryStepEvent[]> {
    return (await this.#lines())
      .filter((line): line is { kind: "step" } & FactoryStepEvent => line.kind === "step" && line.runId === runId)
      .map(({ kind: _kind, ...event }) => event);
  }

  async #lines(): Promise<LedgerLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch {
      return [];
    }
    return parseLines(raw);
  }

  async #folded(): Promise<Map<string, FoldedRun>> {
    return fold(await this.#lines());
  }

  async #safely(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.#warnings.push(`factory run ledger unavailable (${this.#path}): ${messageOf(error)}`);
    }
  }
}
