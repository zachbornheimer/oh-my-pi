import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildPlan, childPrompt, RUNNER_SCRIPT, workerCommand, workerScript } from "./compose.js";
import { type FleetChild, type FleetPorts, listChildren, runFleet } from "./fleet.js";
import factory from "./index.js";
import { normalizeInput, type RawInput } from "./input.js";
import { fleetHome, livePorts } from "./live_ports.js";
import { createTool, DESCRIPTION } from "./tool.js";

const spawnInput = (extra: RawInput = {}): RawInput => ({
  context: "# Goal\nShared preamble.",
  session: "unit",
  tasks: [{ name: "AlphaOne", task: "first" }, { name: "BetaTwo", task: "second" }],
  ...extra,
});

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "task-fleet-home-"));
  cwd = await mkdtemp(join(tmpdir(), "task-fleet-cwd-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Fake host: records the supervisor start and every signal, with deterministic ids and clock. */
function fakePorts() {
  const started: { batchFile: string; runnerPath: string; concurrency: number; cwd: string }[] = [];
  const signalled: number[] = [];
  let counter = 0;
  const ports: FleetPorts = {
    home,
    defaultSession: "process-1",
    cwd,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    randomId: () => (counter++).toString(16).padEnd(32, "0"),
    startSupervisor: (args) => {
      started.push(args);
    },
    terminate: (pid) => {
      signalled.push(pid);
    },
  };
  return { ports, started, signalled };
}

const run = (ports: FleetPorts, raw: RawInput) => runFleet(ports, normalizeInput(raw));

describe("task_fleet input", () => {
  const rejects = (raw: RawInput, message: RegExp) => expect(() => normalizeInput(raw)).toThrow(message);

  it("refuses names that are not CamelCase or are over 32 characters, and accepts exactly 32", () => {
    rejects(spawnInput({ tasks: [{ name: "bad name", task: "x" }] }), /CamelCase/);
    rejects(spawnInput({ tasks: [{ name: "lowerFirst", task: "x" }] }), /CamelCase/);
    rejects(spawnInput({ tasks: [{ name: `A${"b".repeat(32)}`, task: "x" }] }), /CamelCase/);
    expect(normalizeInput(spawnInput({ tasks: [{ name: `A${"b".repeat(31)}`, task: "x" }] })).op).toBe("spawn");
  });

  it("refuses a spawn without context, tasks or an assignment, or with a name used twice", () => {
    rejects({ tasks: [{ name: "NoContext", task: "x" }] }, /context is required/);
    rejects({ context: "  ", tasks: [{ name: "Blank", task: "x" }] }, /context is required/);
    rejects({ context: "# Goal" }, /tasks is required/);
    rejects({ context: "# Goal", tasks: [] }, /tasks is required/);
    rejects(spawnInput({ tasks: [{ name: "Twin", task: "x" }, { name: "Twin", task: "y" }] }), /used twice/);
    rejects(spawnInput({ tasks: [{ name: "Empty", task: " " }] }), /tasks\[0\]\.task is required/);
  });

  it("caps concurrency at 32, defaults to it, and treats null optionals as absent", () => {
    rejects(spawnInput({ max_concurrency: 33 }), /max_concurrency/);
    rejects(spawnInput({ max_concurrency: 0 }), /max_concurrency/);
    rejects(spawnInput({ max_concurrency: 1.5 }), /max_concurrency/);
    const request = normalizeInput(spawnInput({
      op: null,
      max_concurrency: null,
      cwd: null,
      worker_cmd: null,
      tasks: [{ name: "AlphaOne", task: "x", agent: null, model: null, tools: null, solutionSpace: null }],
    }));
    expect(request).toMatchObject({ op: "spawn", maxConcurrency: 32 });
    if (request.op === "spawn") {
      expect(request.tasks[0]).toEqual({
        name: "AlphaOne",
        task: "x",
        agent: undefined,
        model: undefined,
        tools: undefined,
        solutionSpace: undefined,
      });
    }
  });

  it("needs only a session to list, and a target plus content to send", () => {
    expect(normalizeInput({ op: "list", session: "s" }).op).toBe("list");
    rejects({ op: "send", session: "s", content: "hi" }, /to is required/);
    rejects({ op: "send", session: "s", to: "AlphaOne" }, /content is required/);
    rejects({ op: "kill", session: "s" }, /to is required/);
    rejects({ op: "list", session: "../escape" }, /session must be path-safe/);
    expect(normalizeInput({ op: "send", to: "all", content: "x" })).toMatchObject({ from: "parent" });
  });
});

describe("task_fleet composition", () => {
  const plan = (name: string, extra: Partial<ChildPlan["task"]> = {}): ChildPlan => ({
    id: `${name}-0001`,
    name,
    agent: "scout",
    task: { name, task: `do ${name}`, ...extra },
    inboxPath: `/state/${name}/inbox.md`,
  });

  it("gives each child the shared context, its own task, its peers, and its inbox", () => {
    const alpha = plan("AlphaOne", { tools: ["read", "grep"] });
    const prompt = childPrompt("s1", "# Goal\nShared.", alpha, [alpha, plan("BetaTwo")]);
    expect(prompt).toContain("You are `AlphaOne` (agent: scout");
    expect(prompt).toContain("`BetaTwo` (inbox /state/BetaTwo/inbox.md)");
    expect(prompt).toContain("/state/AlphaOne/inbox.md");
    expect(prompt).toContain("limited to: read, grep");
    expect(prompt).toContain("# Goal\nShared.");
    expect(prompt.trimEnd().endsWith("# Your task\ndo AlphaOne")).toBe(true);
    expect(childPrompt("s1", "c", alpha, [alpha])).toContain("no peers");
  });

  it("passes a child's model and tool list to `omp -p`, and a caller's worker verbatim", () => {
    const task = { name: "AlphaOne", task: "x", model: "opus", tools: ["read", "bash"] };
    expect(workerCommand(task, undefined)).toBe("omp -p --model 'opus' --tools 'read,bash'");
    expect(workerCommand({ name: "BetaTwo", task: "x" }, undefined)).toBe("omp -p");
    expect(workerCommand(task, "cat")).toBe("cat");
    expect(workerCommand({ ...task, model: "it's" }, undefined)).toContain(`--model 'it'\\''s'`);
  });

  it("starts the worker in cwd with the child's identity in its environment", () => {
    const script = workerScript("s1", plan("AlphaOne", { tools: ["read"] }), "/work dir", "omp -p");
    expect(script).toContain("export TASK_FLEET_NAME='AlphaOne'");
    expect(script).toContain("export TASK_FLEET_TOOLS='read'");
    expect(script).toContain("cd '/work dir' || exit 127\nexec omp -p");
  });
});

describe("task_fleet with a fake host", () => {
  it("writes each child's files, starts one supervisor, and returns queued children at once", async () => {
    const { ports, started } = fakePorts();
    const output = await run(ports, spawnInput({
      max_concurrency: 3,
      tasks: [{ name: "AlphaOne", task: "first", model: "opus", tools: ["read"] }, { name: "BetaTwo", task: "second" }],
    }));
    expect(output.ids).toEqual(["AlphaOne-00000000", "BetaTwo-10000000"]);
    expect(output.children?.map((child) => [child.name, child.state, child.inbox])).toEqual([
      ["AlphaOne", "queued", 0],
      ["BetaTwo", "queued", 0],
    ]);
    expect(output.children?.[0]).toMatchObject({ agent: "task", model: "opus", tools: ["read"] });

    const dir = join(output.state_dir, "AlphaOne-00000000");
    expect(await readFile(join(dir, "worker.sh"), "utf8")).toContain("exec omp -p --model 'opus' --tools 'read'");
    expect(await readFile(join(dir, "prompt.md"), "utf8")).toContain("# Goal\nShared preamble.");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ concurrency: 3, cwd, runnerPath: join(output.state_dir, "runner.sh") });
    const batch = (await readFile(started[0]!.batchFile, "utf8")).split("\0").filter(Boolean);
    expect(batch).toEqual(output.ids?.map((id) => join(output.state_dir, id)));
  });

  it("uses the default session, resolves a relative cwd, and refuses a missing cwd before starting anything", async () => {
    const { ports, started } = fakePorts();
    await mkdir(join(cwd, "sub"));
    const output = await run(ports, spawnInput({ session: null, cwd: "sub" }));
    expect(output.session).toBe("process-1");
    expect(started[0]?.cwd).toBe(join(cwd, "sub"));

    await expect(run(ports, spawnInput({ cwd: "missing" }))).rejects.toThrow(/is not a directory; no child was started/);
    expect(started).toHaveLength(1);
    expect(existsSync(join(home, "unit"))).toBe(false);
  });

  it("delivers messages to live children by name, id or all, and counts them in the inbox", async () => {
    const { ports } = fakePorts();
    const spawned = await run(ports, spawnInput());
    const sent = await run(ports, { op: "send", session: "unit", to: "AlphaOne", from: "BetaTwo", content: "hello peer" });
    expect(sent.delivered_to).toEqual([spawned.ids![0]!]);
    expect((await run(ports, { op: "send", session: "unit", to: spawned.ids![1]!, content: "by id" })).delivered_to)
      .toEqual([spawned.ids![1]!]);
    expect((await run(ports, { op: "send", session: "unit", to: "all", content: "all" })).delivered_to).toHaveLength(2);

    const listed = await listChildren(spawned.state_dir);
    expect(listed.find((child) => child.name === "AlphaOne")?.inbox).toBe(2);
    expect(listed.find((child) => child.name === "BetaTwo")?.inbox).toBe(2);
    const inbox = await readFile(join(spawned.state_dir, spawned.ids![0]!, "inbox.md"), "utf8");
    expect(inbox).toContain("--- message from BetaTwo at 2026-11-06T12:00:00.000Z\nhello peer\n");

    await expect(run(ports, { op: "send", session: "unit", to: "Nobody", content: "x" })).rejects.toThrow(
      /no child named or with id Nobody in fleet session unit; known: AlphaOne, BetaTwo/,
    );
  });

  it("addresses the newest child when a name is reused across spawns", async () => {
    const { ports } = fakePorts();
    const first = await run(ports, spawnInput({ tasks: [{ name: "AlphaOne", task: "one" }] }));
    // A later spawn gets a later timestamp, so the newest child sorts last.
    const later: FleetPorts = { ...ports, now: () => new Date("2026-11-06T12:05:00.000Z") };
    const second = await run(later, spawnInput({ tasks: [{ name: "AlphaOne", task: "two" }] }));
    const sent = await run(ports, { op: "send", session: "unit", to: "AlphaOne", content: "x" });
    expect(sent.delivered_to).toEqual(second.ids);
    expect(sent.delivered_to).not.toEqual(first.ids);
  });

  it("kills a queued child without a signal, and signals the pid of a running one", async () => {
    const { ports, signalled } = fakePorts();
    const spawned = await run(ports, spawnInput());
    const [alpha, beta] = spawned.ids!;
    expect((await run(ports, { op: "kill", session: "unit", to: "AlphaOne" })).killed).toEqual([alpha!]);
    expect(signalled).toEqual([]);
    expect((await listChildren(spawned.state_dir)).find((child) => child.id === alpha)?.state).toBe("killed");

    await writeFile(join(spawned.state_dir, beta!, "state"), "running");
    await writeFile(join(spawned.state_dir, beta!, "pid"), "4242");
    expect((await run(ports, { op: "kill", session: "unit", to: "all" })).killed).toEqual([beta!]);
    expect(signalled).toEqual([4242]);
    expect((await listChildren(spawned.state_dir)).map((child) => child.state)).toEqual(["killed", "killed"]);
  });

  it("refuses to address a child that has exited or was killed, and keeps a recorded exit over a late kill", async () => {
    const { ports, signalled } = fakePorts();
    const spawned = await run(ports, spawnInput());
    const [alpha, beta] = spawned.ids!;
    await writeFile(join(spawned.state_dir, alpha!, "state"), "exited");
    await writeFile(join(spawned.state_dir, alpha!, "exit_code"), "0");
    await expect(run(ports, { op: "send", session: "unit", to: "AlphaOne", content: "x" })).rejects.toThrow(
      /is exited; only queued or running/,
    );
    await expect(run(ports, { op: "kill", session: "unit", to: "AlphaOne" })).rejects.toThrow(/is exited/);
    // "all" skips the exited child; messages reach only the live one.
    expect((await run(ports, { op: "send", session: "unit", to: "all", content: "x" })).delivered_to).toEqual([beta!]);

    await run(ports, { op: "kill", session: "unit", to: "BetaTwo" });
    await expect(run(ports, { op: "kill", session: "unit", to: "all" })).rejects.toThrow(/no live child/);
    expect(signalled).toEqual([]);
    const listed = await listChildren(spawned.state_dir);
    expect(listed.map((child) => [child.name, child.state, child.exit_code])).toEqual([
      ["AlphaOne", "exited", 0],
      ["BetaTwo", "killed", undefined],
    ]);
  });

  it("ignores a SIGTERM failure for a worker that is already gone", async () => {
    const { ports } = fakePorts();
    const gone: FleetPorts = { ...ports, terminate: () => { throw new Error("ESRCH"); } };
    const spawned = await run(gone, spawnInput({ tasks: [{ name: "AlphaOne", task: "x" }] }));
    await writeFile(join(spawned.state_dir, spawned.ids![0]!, "pid"), "999999");
    expect((await run(gone, { op: "kill", session: "unit", to: "AlphaOne" })).killed).toEqual(spawned.ids!);
  });

  it("lists an unknown session as empty instead of failing", async () => {
    const { ports } = fakePorts();
    expect((await run(ports, { op: "list", session: "never-spawned" })).children).toEqual([]);
  });

  it("skips a child whose marker was written before its runner started", async () => {
    const dir = join(home, "marker");
    await mkdir(dir);
    await writeFile(join(dir, "state"), "queued");
    await writeFile(join(dir, "killed"), "");
    const runner = join(home, "runner.sh");
    await writeFile(runner, RUNNER_SCRIPT);
    expect(spawnSync("/bin/sh", [runner, dir]).status).toBe(0);
    expect(await readFile(join(dir, "state"), "utf8")).toBe("queued");
    expect(existsSync(join(dir, "pid"))).toBe(false);
  });
});

describe("task_fleet tool", () => {
  // A chainable stand-in for pi.zod: the schema itself is checked by the load check against omp's real zod.
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  const pi = { zod: chain, cwd } as unknown as Parameters<typeof createTool>[0];

  it("is discoverable and its description is one 80-250 word block that states the boundary", () => {
    const tool = createTool({ ...pi, cwd }, () => fakePorts().ports);
    expect(tool.name).toBe("task_fleet");
    expect(tool.loadMode).toBe("discoverable");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("built-in `task`");
    expect(DESCRIPTION).not.toContain("\n");
  });

  it("runs an op through execute, returns text plus typed details, and fails on a refused input", async () => {
    const { ports } = fakePorts();
    const tool = createTool(pi, () => ports);
    const result = await tool.execute("id", spawnInput({ op: null }) as never, undefined, undefined as never, undefined);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("started 2 child(ren); none has finished");
    expect((result.details as { ids: string[] }).ids).toHaveLength(2);
    const listed = await tool.execute("id", { op: "list", session: "unit" } as never, undefined, undefined as never, undefined);
    expect((listed.content[0] as { text: string }).text).toContain("AlphaOne [AlphaOne-00000000] queued");

    await expect(tool.execute("id", { op: "send", session: "unit" } as never, undefined, undefined as never, undefined))
      .rejects.toThrow(/to is required/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(tool.execute("id", { op: "list" } as never, undefined, undefined as never, aborted.signal)).rejects.toThrow();
  });

  it("the default export is a factory that builds the tool against the live host", () => {
    const tool = factory({ zod: chain, cwd } as never);
    expect(tool).toMatchObject({ name: "task_fleet", loadMode: "discoverable" });
  });

  it("keeps fleet state under TASK_FLEET_HOME, else the temp directory", () => {
    expect(fleetHome({ TASK_FLEET_HOME: "/x" })).toBe("/x");
    expect(fleetHome({})).toBe(join(tmpdir(), "omp-task-fleet"));
  });
});

/**
 * Real supervisor and runner, with harmless `worker_cmd` workers (`cat`, `sleep`, `echo`): no model, no herdr. The
 * children are detached OS processes, so fake timers cannot drive them; a short real pause between state reads is
 * the only way to observe their state files change.
 */
describe("task_fleet real processes", () => {
  async function childrenWhen(stateDir: string, done: (children: FleetChild[]) => boolean): Promise<FleetChild[]> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const children = await listChildren(stateDir);
      if (done(children)) return children;
      if (Date.now() > deadline) throw new Error(`children never reached the expected state: ${JSON.stringify(children)}`);
      await Bun.sleep(50);
    }
  }

  afterEach(async () => {
    const ports = livePorts({ cwd, home });
    await run(ports, { op: "kill", session: "unit", to: "all" }).catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("returns ids at once, and each child runs its prompt with its identity in the environment", async () => {
    const ports = livePorts({ cwd, home });
    const output = await run(ports, spawnInput({ worker_cmd: `sh -c 'cat; echo "name=$TASK_FLEET_NAME"'` }));
    expect(new Set(output.ids).size).toBe(2);
    expect(output.children?.every((child) => child.state === "queued" || child.state === "running")).toBe(true);

    const children = await childrenWhen(output.state_dir, (all) => all.every((child) => child.state === "exited"));
    for (const child of children) {
      expect(child.exit_code).toBe(0);
      const ran = await readFile(child.output_path, "utf8");
      expect(ran).toContain("# Goal\nShared preamble.");
      expect(ran).toContain(`You are \`${child.name}\``);
      expect(ran).toContain(`name=${child.name}`);
    }
  });

  it("runs at most max_concurrency children at once; the rest queue", async () => {
    const ports = livePorts({ cwd, home });
    const log = join(home, "order.log");
    const worker = `sh -c 'echo "start $TASK_FLEET_NAME" >> ${log}; sleep 0.3; echo "end $TASK_FLEET_NAME" >> ${log}'`;
    const output = await run(ports, spawnInput({ worker_cmd: worker, max_concurrency: 1 }));
    await childrenWhen(output.state_dir, (all) => all.every((child) => child.state === "exited"));
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]?.startsWith("start ")).toBe(true);
    expect(lines[1]).toBe(lines[0]?.replace("start", "end"));
  });

  it("kills a running child by name, keeps the kill recorded, and a queued child never starts", async () => {
    const ports = livePorts({ cwd, home });
    const output = await run(ports, spawnInput({ worker_cmd: "sleep 30", max_concurrency: 1 }));
    await childrenWhen(output.state_dir, (all) => all.some((child) => child.state === "running"));
    const killed = await run(ports, { op: "kill", session: "unit", to: "all" });
    expect(killed.killed).toHaveLength(2);

    const settled = await childrenWhen(output.state_dir, (all) => all.some((child) => child.exit_code !== undefined));
    expect(settled.every((child) => child.state === "killed")).toBe(true);
    const never = settled.find((child) => child.exit_code === undefined);
    expect(never).toBeDefined();
    expect(existsSync(never!.output_path)).toBe(false);
  });
});
