import type { HostMachine } from "./host_machine.js";
/** Where agentmux keeps its captured copies, `<agentmux harness>.<id>.jsonl`, and each project's combined transcript. */
const AGENTMUX_HOME = ".config/agentmux";

export interface Located {
  /** The file to read; undefined when none of the candidates exists. */
  readonly path: string | undefined;
  /** Every place that was looked at, for the error when nothing was found. */
  readonly tried: string[];
}

/** First candidate that is a file. A candidate is a path, or a pattern with `*` that the lookup expands by listing. */
type Candidate = (machine: HostMachine, id: string) => Promise<{ readonly pattern: string; readonly found: string[] }>;

const home = (machine: HostMachine, relative: string): string => `${machine.homeDirectory}/${relative}`;

async function existing(machine: HostMachine, paths: readonly string[]): Promise<string[]> {
  const files = await Promise.all(paths.map(async (path) => (await machine.isFile(path)) ? path : undefined));
  return files.filter((path): path is string => path !== undefined);
}

const exact = (relative: (id: string) => string): Candidate => async (machine, id) => {
  const path = home(machine, relative(id));
  return { pattern: path, found: await existing(machine, [path]) };
};

/** `<root>/*<suffix>(id)`: every directory of `root`, each with the relative path `suffix(id)` inside it. */
const inEachDirectory = (root: string, suffix: (id: string) => string): Candidate => async (machine, id) => {
  const base = home(machine, root);
  const directories = await machine.listDirectory(base);
  return {
    pattern: `${base}/*/${suffix(id)}`,
    found: await existing(machine, directories.map((directory) => `${base}/${directory}/${suffix(id)}`)),
  };
};

/** Codex files its rollouts under `sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl`. */
const codexRollout: Candidate = async (machine, id) => {
  const base = home(machine, ".codex/sessions");
  const found: string[] = [];
  for (const year of await machine.listDirectory(base)) {
    for (const month of await machine.listDirectory(`${base}/${year}`)) {
      for (const day of await machine.listDirectory(`${base}/${year}/${month}`)) {
        const directory = `${base}/${year}/${month}/${day}`;
        for (const name of await machine.listDirectory(directory)) {
          if (name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`)) found.push(`${directory}/${name}`);
        }
      }
    }
  }
  return { pattern: `${base}/*/*/*/rollout-*-${id}.jsonl`, found };
};

/** `<root>/[*]/<time>_<id>.jsonl`: pi and omp name a session file after when it began and its id (the header has the id too). */
const sessionNamedByTimeAndId = (root: string): Candidate => async (machine, id) => {
  const base = home(machine, root);
  const found: string[] = [];
  for (const directory of await machine.listDirectory(base)) {
    for (const name of await machine.listDirectory(`${base}/${directory}`)) {
      if (name.endsWith(`_${id}.jsonl`)) found.push(`${base}/${directory}/${name}`);
    }
  }
  return { pattern: `${base}/*/*_${id}.jsonl`, found };
};

const captured = (agentmuxHarness: string) =>
  exact((id) => `${AGENTMUX_HOME}/transcripts/${agentmuxHarness}.${id}.jsonl`);

/** Candidates per harness in order: agentmux's captured copy first, then the harness's own store. */
const JSONL_CANDIDATES = {
  claude: [captured("claude-code"), inEachDirectory(".claude/projects", (id) => `${id}.jsonl`)],
  grok: [captured("grok"), inEachDirectory(".grok/sessions", (id) => `${id}/chat_history.jsonl`)],
  codex: [captured("codex"), codexRollout],
  cursor: [
    captured("cursor"),
    inEachDirectory(".cursor/projects", (id) => `agent-transcripts/${id}/${id}.jsonl`),
  ],
  agentmux: [exact((id) => `${AGENTMUX_HOME}/projects/${id}/transcript.jsonl`)],
  copilot: [exact((id) => `.copilot/session-state/${id}/events.jsonl`)],
  pi: [sessionNamedByTimeAndId(".pi/agent/sessions")],
  omp: [sessionNamedByTimeAndId(".omp/agent/sessions")],
} as const satisfies Record<string, readonly Candidate[]>;

export type JsonlHarness = keyof typeof JSONL_CANDIDATES;

export function isJsonlHarness(harness: string): harness is JsonlHarness {
  return harness in JSONL_CANDIDATES;
}

/** The transcript file of `<harness>:<id>`, trying agentmux's captured copy before the harness's own store. */
export async function locateJsonl(harness: JsonlHarness, id: string, machine: HostMachine): Promise<Located> {
  const tried: string[] = [];
  for (const candidate of JSONL_CANDIDATES[harness]) {
    const { pattern, found } = await candidate(machine, id);
    tried.push(pattern);
    const [first] = found;
    if (first !== undefined) return { path: first, tried };
  }
  return { path: undefined, tried };
}

/** The directory Grok keeps session `id` in, `~/.grok/sessions/<workspace>/<id>`: the one that holds its `summary.json` and compaction segments. */
export async function grokSessionDirectory(id: string, machine: HostMachine): Promise<string | undefined> {
  const base = home(machine, ".grok/sessions");
  for (const workspace of await machine.listDirectory(base)) {
    const directory = `${base}/${workspace}/${id}`;
    if (await machine.isDirectory(directory)) return directory;
  }
  return undefined;
}

const cursorLegacyStore = inEachDirectory(".cursor/chats", (id) => `${id}/store.db`);

/** The `store.db` of Cursor's older chat storage, `~/.cursor/chats/<outer>/<id>/store.db`, for a session with no agent transcript. */
export async function locateCursorLegacyStore(id: string, machine: HostMachine): Promise<Located> {
  const { pattern, found } = await cursorLegacyStore(machine, id);
  return { path: found[0], tried: [pattern] };
}
