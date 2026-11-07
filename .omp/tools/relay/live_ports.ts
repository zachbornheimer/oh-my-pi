import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { sleep } from "./exec.js";
import { fixRedCi } from "./fix_red_ci.js";
import { githubPort } from "./github.js";
import { linearGraphql, linearPort } from "./linear.js";
import { AgentStore, askBare, IMPROVE_BUDGET_MS, REVIEW_BUDGET_MS, REVIEWER_MODEL, runAgent, WORK_BUDGET_MS } from "./omp.js";
import type { RelayPorts } from "./types.js";

/** Where the relay keeps what it needs between steps: the scratch directories and the reviewer's verdict files. */
export function relayCacheDir(home = homedir()): string {
  return join(home, ".cache", "omp-relay");
}

/**
 * The checkout the tooling pass runs in: the repository with `mise.toml` and the `mastra` package, where the workflows, tools
 * and skills live. `RELAY_TOOLING_CHECKOUT` names it; otherwise `~/Developer/Personal/capability-replicas`. Throws when the
 * directory does not look like it, naming the variable to set.
 */
export function toolingCheckout(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const checkout = env.RELAY_TOOLING_CHECKOUT?.trim() || join(home, "Developer", "Personal", "capability-replicas");
  if (!existsSync(join(checkout, "mise.toml")) || !existsSync(join(checkout, "mastra", "package.json"))) {
    throw new Error(`the tooling checkout (mise.toml beside mastra/) was not found at ${checkout}; set RELAY_TOOLING_CHECKOUT to it`);
  }
  return checkout;
}

export type LiveRelay = {
  ports: RelayPorts;
  verdictDirectory: string;
  /** Removes the run's private omp store. Always call it, on success and on failure. */
  dispose(): Promise<void>;
};

/**
 * The real Linear, GitHub, `omp` and `gh` for one run. The relay's own headless omp calls (the /tickets question, the
 * reviewer, the ticket worker, the tooling pass, the red-CI fixer) all run against one private omp store, so they never
 * contend with the box's other omp processes for `~/.omp/agent`; it is made on first use and removed by `dispose`.
 */
export function liveRelayPorts(options: { exec: Exec; signal?: AbortSignal; home?: string; env?: NodeJS.ProcessEnv }): LiveRelay {
  const { exec, signal } = options;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const cache = relayCacheDir(home);
  const store = new AgentStore(join(home, ".omp", "agent"));
  const verdictDirectory = join(cache, "reviews");
  const workDirectory = join(cache, "relay-work");
  const reviewDirectory = join(cache, "review-without-checkout");
  const ports: RelayPorts = {
    linear: linearPort(linearGraphql()),
    github: githubPort(exec, signal),
    sleep: (ms) => sleep(ms, signal),
    readSkill: (name) => readFile(join(home, ".agents", "skills", name, "SKILL.md"), "utf8"),
    ask: ({ prompt }) => askBare(exec, store, prompt, signal),
    async review({ prompt, verdictPath }) {
      await mkdir(verdictDirectory, { recursive: true });
      await rm(verdictPath, { force: true });
      await runAgent(exec, store, { cwd: reviewDirectory, prompt, model: REVIEWER_MODEL, timeoutMs: REVIEW_BUDGET_MS, label: `the reviewer (${REVIEWER_MODEL})`, signal });
      return readFile(verdictPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`the reviewer wrote no verdict file at ${verdictPath}`);
        throw error;
      });
    },
    fixRedCi: ({ prUrl }) => fixRedCi({ exec, store, sleep: (ms) => sleep(ms, signal), now: Date.now, signal }, prUrl),
    work: ({ prompt }) => runAgent(exec, store, { cwd: workDirectory, prompt, timeoutMs: WORK_BUDGET_MS, label: "the relay's ticket worker", signal }),
    improve: async ({ prompt }) =>
      runAgent(exec, store, { cwd: toolingCheckout(env, home), prompt, timeoutMs: IMPROVE_BUDGET_MS, label: "the relay's tooling pass", signal }),
  };
  return { ports, verdictDirectory, dispose: () => store.dispose() };
}
