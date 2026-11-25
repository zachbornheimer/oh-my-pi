/**
 * What the omp process around a session did to it: which parts of the host were loaded when, and
 * how. The `/session` panel shows this as a "Lifecycle" block plus reload, resume and goal lists.
 *
 * Two stores, split by lifetime:
 * - **Process loads** (`omp`, `extensions`, `tools`, `skills`) live in memory. They answer "what is
 *   running now", which a session file cannot: a resumed session is on this process's loads.
 * - **Host events** are `host_event` session entries. They answer "what happened to this session":
 *   every reload that replaced part of the host and every resume. They survive a restart.
 */
import type { HostEventEntry, SessionEntry } from "./session-entries";

/** A part of the host that can be (re)loaded independently. */
export type HostLoadKind = "omp" | "extensions" | "tools" | "skills";

/** What a `host_event` entry records: a load kind, or the session being resumed. */
export type HostEventKind = HostLoadKind | "resume";

/**
 * How the event came about.
 * - `cli`: process start (flags, auto-resume, or a plain launch).
 * - `command`: the user ran a command (`/resume`).
 * - `hot-reload`: omp noticed changed files and reloaded without being asked.
 * - `reload-plugins`: the user ran `/reload-plugins`.
 */
export type HostEventTrigger = "cli" | "command" | "hot-reload" | "reload-plugins";

export interface HostLoad {
	/** Epoch milliseconds. */
	at: number;
	trigger: HostEventTrigger;
}

const HOST_LOAD_KINDS: readonly HostLoadKind[] = ["omp", "extensions", "tools", "skills"];

const processStartedAt = Date.now();
const processLoads = new Map<HostLoadKind, HostLoad>(
	HOST_LOAD_KINDS.map(kind => [kind, { at: processStartedAt, trigger: "cli" }]),
);

/** Where a recorded event is also persisted: the session the host is attached to. */
export interface HostEventSink {
	appendHostEvent(kind: HostEventKind, trigger: HostEventTrigger): unknown;
}

/**
 * Note that `kind` was just loaded by `trigger`: it becomes the process's latest load, and is
 * appended to the session as a `host_event` when the load replaced something already running (a
 * reload). A start-up load is not persisted; the process start is already in every entry's
 * `runtime` stamp.
 */
export function recordHostLoad(
	sink: HostEventSink | undefined,
	kind: HostLoadKind,
	trigger: HostEventTrigger,
	now: number = Date.now(),
): void {
	processLoads.set(kind, { at: now, trigger });
	if (trigger !== "cli") sink?.appendHostEvent(kind, trigger);
}

/** The process's latest load of each kind. */
export function currentHostLoads(): ReadonlyMap<HostLoadKind, HostLoad> {
	return processLoads;
}

/** Test seam: forget every in-memory load and start over from `now`. */
export function resetHostLoadsForTest(now: number = Date.now()): void {
	for (const kind of HOST_LOAD_KINDS) processLoads.set(kind, { at: now, trigger: "cli" });
}

function isHostEvent(entry: SessionEntry): entry is HostEventEntry {
	return entry.type === "host_event";
}

/** The `host_event` entries of `entries` that load a part of the host (not resumes), newest first. */
export function hostReloadHistory(entries: readonly SessionEntry[]): HostEventEntry[] {
	return entries
		.filter(isHostEvent)
		.filter(entry => entry.kind !== "resume")
		.reverse();
}

/** The `host_event` resume entries of `entries`, newest first. */
export function hostResumeHistory(entries: readonly SessionEntry[]): HostEventEntry[] {
	return entries
		.filter(isHostEvent)
		.filter(entry => entry.kind === "resume")
		.reverse();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Nov 25, 2026 - 10:12am`, in the machine's local time. */
export function formatHostTime(at: number | string | Date): string {
	const date = at instanceof Date ? at : new Date(at);
	if (Number.isNaN(date.getTime())) return "unknown";
	const hours = date.getHours();
	const hour12 = hours % 12 === 0 ? 12 : hours % 12;
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const meridiem = hours < 12 ? "am" : "pm";
	return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} - ${hour12}:${minutes}${meridiem}`;
}

/** One goal a session is working toward, from whoever set it. */
export interface SessionGoalRow {
	/** Who set it, e.g. `user`, `autogoal`. */
	source: string;
	/** Epoch milliseconds the goal was set. */
	at: number;
	goal: string;
}

/** An extension's goals, read each time `/session` opens. */
export type SessionGoalsProvider = () => readonly SessionGoalRow[];

/** One headed block of the report; `rows` empty means print `empty` instead. */
export interface LifecycleSection {
	head: string;
	rows: Array<{ key: string; value: string }>;
	empty: string;
}

export interface LifecycleInput {
	/** The session header's creation timestamp. */
	createdAt: string;
	loads: ReadonlyMap<HostLoadKind, HostLoad>;
	entries: readonly SessionEntry[];
	goals: readonly SessionGoalRow[];
}

const LOAD_LABELS: ReadonlyArray<readonly [HostLoadKind, string]> = [
	["omp", "Omp loaded"],
	["extensions", "Extensions loaded"],
	["skills", "Skills loaded"],
	["tools", "Tools loaded"],
];

/**
 * The `/session` blocks this module owns, in display order: Lifecycle, Reload history, Resume
 * history, Goals. Lists are newest first.
 */
export function lifecycleSections(input: LifecycleInput): LifecycleSection[] {
	const lifecycle: LifecycleSection = {
		head: "Lifecycle",
		rows: [{ key: "Created", value: formatHostTime(input.createdAt) }],
		empty: "",
	};
	for (const [kind, label] of LOAD_LABELS) {
		const load = input.loads.get(kind);
		if (load) lifecycle.rows.push({ key: label, value: `${formatHostTime(load.at)}, ${load.trigger}` });
	}
	return [
		lifecycle,
		{
			head: "Reload history",
			rows: hostReloadHistory(input.entries).map(entry => ({
				key: formatHostTime(entry.timestamp),
				value: `${entry.kind}, ${entry.trigger}`,
			})),
			empty: "None this session",
		},
		{
			head: "Resume history",
			rows: hostResumeHistory(input.entries).map(entry => ({
				key: formatHostTime(entry.timestamp),
				value: entry.trigger,
			})),
			empty: "Never resumed",
		},
		{
			head: "Goals",
			rows: [...input.goals]
				.sort((a, b) => b.at - a.at)
				.map(goal => ({ key: `${goal.source}, ${formatHostTime(goal.at)}`, value: goal.goal })),
			empty: "None",
		},
	];
}
