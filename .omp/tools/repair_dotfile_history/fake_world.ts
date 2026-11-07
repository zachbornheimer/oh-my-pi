/**
 * A temp world for the `repair_dotfile_history` tests: a real bare git store in a temp directory, real `git` and `cp`/`mv`,
 * and fakes for the only things that would touch the machine: `launchctl`, `pgrep` and `mise`. Nothing here reads or writes
 * the real home directory or the real history store.
 */
import { execFileSync, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, RepairPorts } from "./repair.ts";

export const TOOL_PATH = "home/.local/bin/tool";
export const OTHER_PATH = "home/.zshrc";
export const ENCRYPTED = "mise-encrypted-file-v1:ciphertext";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // The temp world must not depend on, or be changed by, the machine's git configuration (signing, hooks, templates).
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Runs git (or any program) synchronously and returns trimmed stdout. */
export function sh(cwd: string, command: string, args: string[], input?: string, env: Record<string, string> = {}): string {
  if (command !== "git") throw new Error(`the temp world only runs git synchronously, not: ${command}`);
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, ...IDENTITY, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** The only real programs the playbook runs against the temp world; anything else is a test mistake. */
function spawnTempWorldProgram(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) {
  switch (command) {
    case "git":
      return spawn("git", [...args], options);
    case "env":
      return spawn("env", [...args], options);
    case "mv":
      return spawn("mv", [...args], options);
    case "/bin/cp":
      return spawn("/bin/cp", [...args], options);
    default:
      throw new Error(`the temp world does not run: ${command}`);
  }
}

/** A real process, as `pi.exec` would run it. */
export function realExec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
  const { promise, resolve } = Promise.withResolvers<ExecResult>();
  const child = spawnTempWorldProgram(command, args, { cwd: options?.cwd, env: { ...process.env, ...IDENTITY } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  child.on("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}`, code: 127, killed: false }));
  child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1, killed: false }));
  return promise;
}

export interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

export interface WorldOptions {
  /** Where origin/setup points: `published` (the encrypted c1, the default) or `plaintext` (c2, so the guard must refuse). */
  readonly origin?: "published" | "plaintext";
  /** What the fake `mise dot save` writes. */
  readonly save?: "encrypted" | "plaintext" | "nothing";
  /** What the fake `mise dot sync` prints. */
  readonly sync?: "published" | "cannot-publish";
  /** The watcher survives `launchctl bootout`. */
  readonly stubbornWatcher?: boolean;
  /** `mise bootstrap services apply` does not bring the watcher back. */
  readonly servicesStayDown?: boolean;
  /** The first `mise dot save` fails with the transient lock message. */
  readonly lockedOnce?: boolean;
  /** The second `cp -R` (copy to store) leaves a partial directory and fails. */
  readonly copyIntoStoreFails?: boolean;
  /** `mise dot save` aborts this controller and reports the process killed. */
  readonly abortOnSave?: AbortController;
}

export interface World {
  readonly root: string;
  readonly home: string;
  readonly storeDir: string;
  readonly tmpRoot: string;
  readonly calls: Call[];
  readonly sleeps: number[];
  readonly state: { watcher: boolean };
  readonly shas: { readonly c1: string; readonly c2: string; readonly c3: string; readonly c4: string };
  readonly ports: RepairPorts;
  git(...args: string[]): string;
  /** `name sha` for every ref in the store, sorted. */
  refs(): string[];
  cleanup(): void;
}

/** One commit in the work repo that sets `files`. */
function commit(work: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
    sh(work, "git", ["add", path]);
  }
  sh(work, "git", ["commit", "--no-verify", "-q", "-m", message]);
  return sh(work, "git", ["rev-parse", "HEAD"]);
}

export function makeWorld(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), "repair-dotfile-world-"));
  const home = join(root, "home");
  const tmpRoot = join(root, "tmp");
  const storeDir = join(home, ".local", "state", "mise", "history", "repo.git");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(join(storeDir, ".."), { recursive: true });
  const work = join(root, "work");
  mkdirSync(work);
  sh(work, "git", ["init", "-q", "-b", "main"]);
  // c1 is published and encrypted; c2 and c3 are local-only plaintext for TOOL_PATH; c4 is an unrelated later change.
  const c1 = commit(work, { [OTHER_PATH]: `${ENCRYPTED}-zshrc` }, "c1 published");
  const c2 = commit(work, { [TOOL_PATH]: "#!/bin/sh\necho one\n" }, "c2 plaintext");
  const c3 = commit(work, { [TOOL_PATH]: "#!/bin/sh\necho two\n" }, "c3 plaintext");
  const c4 = commit(work, { [OTHER_PATH]: `${ENCRYPTED}-zshrc-2` }, "c4 local change");
  // Clone instead of push: a bare store with the same objects, then the refs a mise history store carries.
  sh(work, "git", ["clone", "-q", "--bare", work, storeDir]);
  const origin = options.origin === "plaintext" ? c2 : c1;
  sh(storeDir, "git", ["update-ref", "refs/heads/main", c4]);
  sh(storeDir, "git", ["update-ref", "refs/remotes/origin/setup", origin]);
  sh(storeDir, "git", ["update-ref", "refs/heads/backup-1", c1]);

  const calls: Call[] = [];
  const sleeps: number[] = [];
  const state = { watcher: true };
  const git = (...args: string[]): string => sh(storeDir, "git", args);
  let saves = 0;
  let copies = 0;

  /** Commits `content` at `storePath` on the store's main, as `mise dot save` would. */
  const saveInto = (storePath: string, content: string): void => {
    const index = join(root, `index-${Date.now()}-${Math.random()}`);
    const env = { GIT_INDEX_FILE: index };
    const blob = sh(storeDir, "git", ["hash-object", "-w", "--stdin"], content);
    sh(storeDir, "git", ["--git-dir", storeDir, "read-tree", "main"], undefined, env);
    sh(storeDir, "git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${storePath}`], undefined, env);
    const tree = sh(storeDir, "git", ["write-tree"], undefined, env);
    const parent = sh(storeDir, "git", ["rev-parse", "main"]);
    const next = sh(storeDir, "git", ["commit-tree", tree, "-p", parent, "-m", "save"], undefined, env);
    sh(storeDir, "git", ["update-ref", "refs/heads/main", next]);
    rmSync(index, { force: true });
  };

  const exec = async (command: string, args: readonly string[], execOptions?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args });
    const done = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr, killed: false });
    if (command === "pgrep") return done(state.watcher ? 0 : 1, state.watcher ? "123 mise dot watch\n" : "");
    if (command === "launchctl") {
      if (args[0] === "bootout" && !options.stubbornWatcher) state.watcher = false;
      return done(0);
    }
    if (command === "mise") {
      const [first, second] = args;
      if (first === "bootstrap") {
        if (!options.servicesStayDown) state.watcher = true;
        return done(0, "applied\n");
      }
      if (first === "dot" && second === "save") {
        saves += 1;
        if (options.abortOnSave) {
          options.abortOnSave.abort();
          return { code: -1, stdout: "", stderr: "", killed: true };
        }
        if (options.lockedOnce && saves === 1) return done(1, "", "another history operation is running");
        const live = args[2] ?? "";
        const storePath = `home/${live.slice(`${home}/`.length)}`;
        if (!live.startsWith(`${home}/`)) return done(1, "", `not tracked: ${live}`);
        if (options.save === "plaintext") saveInto(storePath, "back to plaintext\n");
        else if (options.save !== "nothing") saveInto(storePath, ENCRYPTED);
        return done(0, "saved\n");
      }
      if (first === "dot" && second === "sync") {
        if (options.sync === "cannot-publish") return done(0, "cannot publish: plaintext history\n");
        sh(storeDir, "git", ["update-ref", "refs/remotes/origin/setup", sh(storeDir, "git", ["rev-parse", "main"])]);
        return done(0, "synced\n");
      }
      return done(1, "", `unfaked mise call: ${args.join(" ")}`);
    }
    if (command === "/bin/cp" && options.copyIntoStoreFails) {
      copies += 1;
      if (copies === 2) {
        mkdirSync(join(args[2] ?? "", "partial"), { recursive: true });
        return done(1, "", "cp: no space left on device");
      }
    }
    return realExec(command, args, execOptions);
  };

  const ports: RepairPorts = {
    exec,
    home,
    storeDir,
    tmpRoot,
    uid: 501,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };

  return {
    root,
    home,
    storeDir,
    tmpRoot,
    calls,
    sleeps,
    state,
    shas: { c1, c2, c3, c4 },
    ports,
    git,
    refs: () => git("for-each-ref", "--format=%(refname:short) %(objectname)").split("\n").sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
