/**
 * The per-ticket chain: prepare it, ask whether a later ticket supersedes it, validate that it is still current, then hand it to the
 * relay. Every step is a port. Live, each port is a full omp session calling the native tool of that name (`omp_delegate.ts`); a test
 * scripts them.
 */

export interface Prepared {
  ready_for_work: boolean;
  status: string;
  reason?: string;
}
export interface SupersededBy {
  id: string;
  filed_at: string;
  why: string;
}
export interface Supersession {
  verdict: "superseded" | "not_superseded" | "unverified";
  superseded_by: SupersededBy[];
  evidence: string;
}
export interface PullRequestRef {
  url: string;
  title: string | null;
}
export interface Validation {
  verdict: "current" | "not_current" | "unverified";
  reasons: string[];
  status: string | null;
  status_type: string | null;
  open_pull_requests: PullRequestRef[];
}
export interface RelayAnswer {
  outcome?: string;
  linearStatus?: string;
  summary?: string;
  pullRequests: string[];
  closedPullRequests: string[];
  tooling?: string;
}
export interface Settled {
  status: string;
  closedPullRequests: string[];
}

export interface TicketPorts {
  prepare(ticket: string): Promise<Prepared>;
  findSuperseding(ticket: string): Promise<Supersession>;
  validate(ticket: string, supersession: Supersession): Promise<Validation>;
  /** Closes a superseded ticket and its open pull requests, each write read back. */
  closeSuperseded(ticket: string, supersession: Supersession, validation: Validation): Promise<Settled>;
  relay(ticket: string): Promise<RelayAnswer>;
}

export const TICKET_OUTCOMES = [
  "implemented",
  "relayed",
  "not_ready",
  "superseded",
  "not_current",
  "unverified",
  "validated",
  "failed",
] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export interface TicketRun {
  ticket: string;
  outcome: TicketOutcome;
  prepare?: Prepared;
  supersession?: Supersession;
  validation?: Omit<Validation, "status_type">;
  relay?: RelayAnswer;
  linearStatus?: string;
  closedPullRequests: string[];
  detail?: string;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Linear's own statuses that mean the ticket is finished, whatever the team calls them. */
const TERMINAL = new Set(["completed", "canceled"]);

/**
 * One ticket through the chain. It stops at the first stage that says the ticket should not be worked and names that stage. A step that
 * throws ends this ticket's run as `failed` with the step named; the next ticket is unaffected.
 */
export async function workTicket(ticket: string, ports: TicketPorts, options: { apply: boolean }): Promise<TicketRun> {
  const run: TicketRun = { ticket, outcome: "failed", closedPullRequests: [] };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      run.outcome = "failed";
      run.detail = `${name}: ${reasonOf(error)}`;
      return undefined;
    }
  };

  const prepared = await step("prepare_ticket", () => ports.prepare(ticket));
  if (prepared === undefined) return run;
  run.prepare = {
    ready_for_work: prepared.ready_for_work,
    status: prepared.status,
    ...(prepared.reason === undefined ? {} : { reason: prepared.reason }),
  };

  const supersession = await step("find_superseding_tickets", () => ports.findSuperseding(ticket));
  if (supersession === undefined) return run;
  run.supersession = supersession;

  const validation = await step("validate_ticket", () => ports.validate(ticket, supersession));
  if (validation === undefined) return run;
  run.validation = {
    verdict: validation.verdict,
    reasons: validation.reasons,
    status: validation.status,
    open_pull_requests: validation.open_pull_requests,
  };

  if (validation.verdict === "not_current") {
    if (supersession.verdict !== "superseded") return { ...run, outcome: "not_current", detail: validation.reasons.join("; ") };
    // Already closed in Linear and nothing open to close: there is nothing left to write.
    const finished = validation.status_type !== null && TERMINAL.has(validation.status_type);
    if (finished && validation.open_pull_requests.length === 0) {
      return { ...run, outcome: "superseded", detail: validation.reasons.join("; ") };
    }
    const settled = await step("close superseded ticket", () => ports.closeSuperseded(ticket, supersession, validation));
    if (settled === undefined) return run;
    return {
      ...run,
      outcome: "superseded",
      linearStatus: settled.status,
      closedPullRequests: [...settled.closedPullRequests],
      detail: validation.reasons.join("; "),
    };
  }
  if (validation.verdict === "unverified") return { ...run, outcome: "unverified", detail: validation.reasons.join("; ") };
  if (!prepared.ready_for_work) return { ...run, outcome: "not_ready", detail: prepared.reason };
  if (!options.apply) return { ...run, outcome: "validated" };

  const relayed = await step("relay", () => ports.relay(ticket));
  if (relayed === undefined) return run;
  return {
    ...run,
    outcome: relayed.outcome === "work_completed" ? "implemented" : "relayed",
    relay: { ...relayed, pullRequests: [...relayed.pullRequests], closedPullRequests: [...relayed.closedPullRequests] },
    ...(relayed.linearStatus === undefined ? {} : { linearStatus: relayed.linearStatus }),
    closedPullRequests: [...relayed.closedPullRequests],
  };
}

// ---- validators for what the native tools answer ------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function str(value: Obj, key: string, optional = false): string | undefined {
  const v = value[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}
function strOrNull(value: Obj, key: string): string | null {
  const v = value[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`${key} must be a string or null`);
  return v;
}
function strings(value: Obj, key: string): string[] {
  const v = value[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${key} must be an array of strings`);
  return v as string[];
}
function oneOf<T extends string>(value: Obj, key: string, allowed: readonly T[]): T {
  const v = value[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return v as T;
}
function objects(value: Obj, key: string): Obj[] {
  const v = value[key];
  if (!Array.isArray(v) || v.some((x) => x === null || typeof x !== "object")) throw new Error(`${key} must be an array of objects`);
  return v as Obj[];
}

export function preparedOf(value: Obj): Prepared {
  if (typeof value.ready_for_work !== "boolean") throw new Error("ready_for_work must be a boolean");
  const reason = str(value, "reason", true);
  return { ready_for_work: value.ready_for_work, status: str(value, "status")!, ...(reason === undefined ? {} : { reason }) };
}
export function supersessionOf(value: Obj): Supersession {
  return {
    verdict: oneOf(value, "verdict", ["superseded", "not_superseded", "unverified"] as const),
    superseded_by: objects(value, "superseded_by").map((o) => ({ id: str(o, "id")!, filed_at: str(o, "filed_at")!, why: str(o, "why")! })),
    evidence: str(value, "evidence")!,
  };
}
export function validationOf(value: Obj): Validation {
  return {
    verdict: oneOf(value, "verdict", ["current", "not_current", "unverified"] as const),
    reasons: strings(value, "reasons"),
    status: strOrNull(value, "status"),
    status_type: strOrNull(value, "status_type"),
    open_pull_requests: objects(value, "open_pull_requests").map((o) => ({ url: str(o, "url")!, title: strOrNull(o, "title") })),
  };
}
export function settledOf(value: Obj): Settled {
  return { status: str(value, "status")!, closedPullRequests: strings(value, "closedPullRequests") };
}
export function relayOf(value: Obj): RelayAnswer {
  const answer: RelayAnswer = { pullRequests: strings(value, "pullRequests"), closedPullRequests: strings(value, "closedPullRequests") };
  for (const key of ["outcome", "linearStatus", "summary", "tooling"] as const) {
    const v = str(value, key, true);
    if (v !== undefined) answer[key] = v;
  }
  return answer;
}
export function ticketsOf(value: Obj): string[] {
  return strings(value, "tickets");
}
