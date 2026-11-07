/**
 * `host_bottlenecks` against fakes: the family rules, the model step, the gatherer, the recorded snapshot of a loaded
 * Mac, and the tool's execute. Ported from the Mastra capability's tests. Nothing here runs a real command or a real model.
 */
import { describe, expect, it } from "bun:test";
import { analyzeHost } from "./analyze.ts";
import { scopeOf } from "./family_context.ts";
import { type HostClock, diskRow, gatherSnapshot, secondsOf, swapOf } from "./gather.ts";
import { DESCRIPTION, buildTool, execMachine, renderReport } from "./index.ts";
import { type ExecResult, type ModelStep, BARE_OMP_FLAGS, askJson, ompModelStep, parseJsonReply } from "./omp_model.ts";
import { kindOf } from "./process_command.ts";
import { FakeMachine, ok, proc, snapshotOf, type SnapshotSpec } from "./snapshot_builders.ts";
import type { Family, HostBottlenecksOutput, HostSnapshot } from "./types.ts";
import { askVerdicts, validReply, verdictBrief } from "./unknown_verdicts.ts";
import { VERDICT_INSTRUCTIONS, verdictPrompt } from "./verdict_prompt.ts";

const REPO = "/Users/zach/Developer/Personal/capability-replicas";
const HOOK_CONFIG = `${REPO}/hk.pkl`;
const REPO_WORLD = {
  cwd: { "14": REPO, "32": REPO },
  repo: { [REPO]: REPO },
  hook_config: { [REPO]: HOOK_CONFIG },
};

type Verdicts = { Verdicts: Record<string, unknown>[] };

/** A model step that answers `answer(call, prompt)` as JSON text and records every prompt it was shown. */
function scripted(answer: (call: number, prompt: string) => unknown = () => ({ Verdicts: [] })) {
  const prompts: string[] = [];
  const step: ModelStep = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify(answer(prompts.length, prompt));
  };
  return { step, prompts };
}

/** The root_pids of the families the prompt asks about: the lines after the final `Prompt:`, never the examples'. */
function listedPids(prompt: string): number[] {
  const brief = prompt.slice(prompt.lastIndexOf("\nPrompt:\n"));
  return [...brief.matchAll(/^Family root_pid (\d+):/gm)].map((match) => Number(match[1]));
}
function hostWorld(answer?: (call: number, prompt: string) => unknown) {
  const model = scripted(answer);
  const run = (spec: SnapshotSpec, options: { top?: number; include_normal?: boolean } = {}) =>
    analyzeHost(snapshotOf({ ...REPO_WORLD, ...spec }), { top: options.top ?? 10, include_normal: options.include_normal ?? false }, model.step);
  return { run, prompts: model.prompts };
}

const familyNamed = (output: HostBottlenecksOutput, name: string): Family => {
  const found = [...output.families, ...output.normal].find((family) => family.name.startsWith(name));
  if (found === undefined) throw new Error(`no family named ${name}`);
  return found;
};

describe("the family rules", () => {
  it("calls go test ./... under git push under hk pre-push overscoped, without asking the model", async () => {
    const { run, prompts } = hostWorld();
    const output = await run({
      processes: [
        proc(10, 1, "/usr/local/bin/claude", 5, 400),
        proc(11, 10, "/usr/local/bin/wt step push"),
        proc(12, 11, "git push origin main"),
        proc(13, 12, "hk run pre-push", 1),
        proc(14, 13, "go test ./...", 300, 900),
      ],
    });
    const family = familyNamed(output, "wt");
    expect(family).toMatchObject({
      verdict: "overscoped",
      kind: "test",
      trigger: "git push",
      hook_phase: "pre-push",
      repo: REPO,
      scope: { whole_tree: true },
      remedy: "scope_hook_to_changed_files",
      confidence: 0.9,
    });
    expect(family.evidence[0]).toBe(`pid 14 go test ./... under git push (pre-push) in ${REPO}: whole tree`);
    expect(prompts).toHaveLength(0);
  });

  it("calls sixty docker processes under one docker-mcp a runaway and lists the pids to kill", async () => {
    const { run } = hostWorld();
    const dockers = Array.from({ length: 60 }, (_, index) => proc(100 + index, 20, "docker run --rm mcp/server", 1, 20));
    const output = await run({ processes: [proc(10, 1, "claude"), proc(20, 10, "docker-mcp gateway run", 2), ...dockers] });
    const family = familyNamed(output, "docker-mcp");
    expect(family).toMatchObject({ verdict: "runaway", remedy: "cap_fan_out", count: 61 });
    expect(family.advice).toContain("kill 20 100 101");
    expect(family.advice).toContain("159");
  });

  it("calls a 9 GB llama-server normal and keeps it out of families unless asked", async () => {
    const { run } = hostWorld();
    const spec = { processes: [proc(60, 1, "llama-server -m big.gguf", 4, 9216)] };
    const quiet = await run(spec);
    expect(quiet.families.map((family) => family.name)).not.toContain("llama-server");
    expect(quiet.normal.find((family) => family.name === "llama-server")).toMatchObject({ verdict: "normal", remedy: "none" });
    const all = await run(spec, { include_normal: true });
    expect(all.families.map((family) => family.name)).toContain("llama-server");
  });

  it("never marks idle model servers or an agent session as contention, and does mark two busy model servers", async () => {
    const { run } = hostWorld();
    const idle = await run({
      ncpu: 4,
      avg1: 40,
      processes: [
        proc(90, 1, "ollama serve", 1, 8000),
        proc(91, 1, "llama-server -m a.gguf", 2, 9000),
        proc(92, 1, "claude", 30, 500),
        proc(93, 1, "dprint check", 50),
        proc(94, 1, "eslint src/a.ts", 50),
      ],
    });
    const verdicts = Object.fromEntries([...idle.families, ...idle.normal].map((f) => [f.name, f.verdict]));
    expect(verdicts).toMatchObject({ ollama: "normal", "llama-server": "normal", claude: "normal", dprint: "contention" });
    const busy = await run({
      processes: [proc(90, 1, "ollama serve", 80, 8000), proc(91, 1, "llama-server -m a.gguf", 70, 9000)],
    });
    expect(busy.families.map((family) => family.verdict)).toEqual(["contention", "contention"]);
  });

  it("calls dprint over the whole tree under git commit overscoped and names the repo and its hook config", async () => {
    const { run } = hostWorld();
    const output = await run({
      processes: [proc(30, 1, "git commit -m wip"), proc(31, 30, "hk run pre-commit"), proc(32, 31, "dprint check", 150, 300)],
    });
    const family = familyNamed(output, "git");
    expect(family).toMatchObject({ verdict: "overscoped", kind: "gate", trigger: "git commit" });
    expect(family.advice).toContain(REPO);
    expect(family.advice).toContain(HOOK_CONFIG);
  });

  it("calls a pre-push gate under git commit overscoped even when it was given files", async () => {
    const { run } = hostWorld();
    const output = await run({
      processes: [proc(30, 1, "git commit -m wip"), proc(31, 30, "hk run pre-push"), proc(32, 31, "dprint check src/a.ts", 100)],
    });
    expect(familyNamed(output, "git")).toMatchObject({ verdict: "overscoped", hook_phase: "pre-push" });
  });

  it("calls two vitest runs and a go test at load 3 per core contention to serialize", async () => {
    const { run } = hostWorld();
    const output = await run({
      ncpu: 10,
      avg1: 30,
      processes: [
        proc(70, 1, "node /repo/node_modules/.bin/vitest run src/a.test.ts", 90),
        proc(71, 1, "node /repo/node_modules/.bin/vitest run src/b.test.ts", 80),
        proc(72, 1, "go test ./internal/x", 70),
      ],
    });
    expect(output.load.ratio).toBe(3);
    const contended = output.families.filter((family) => family.verdict === "contention");
    expect(contended).toHaveLength(3);
    expect(contended.every((family) => family.remedy === "serialize_gates")).toBe(true);
  });

  it("calls a gate left running for a day with no agent or shell above it a stale runaway", async () => {
    const { run } = hostWorld();
    const output = await run({ processes: [proc(80, 1, "eslint src/a.ts", 10, 200, 25 * 3600)] });
    expect(output.families[0]).toMatchObject({ verdict: "runaway", remedy: "kill_stale" });
    expect(output.families[0]!.advice).toContain("kill 80");
  });

  it("states the load ratio, the worst family and its remedy without a model", async () => {
    const { run, prompts } = hostWorld();
    const output = await run({
      ncpu: 2,
      avg1: 1,
      processes: [proc(30, 1, "git commit -m wip"), proc(31, 30, "hk run pre-commit"), proc(32, 31, "dprint check", 150, 300)],
    });
    expect(output.summary).toStartWith("Load 0.50 per core (avg1 1 on 2 cores). Worst: git");
    expect(output.summary).toContain("remedy scope_hook_to_changed_files");
    expect(prompts).toHaveLength(0);
  });

  it("calls a VM whose containers demand more cores than it has contention, and says what to cap", async () => {
    const { run } = hostWorld();
    const output = await run({
      processes: [proc(20, 1, "com.apple.Virtualization.VirtualMachine", 363, 9500)],
      vms: [{
        pid: 20,
        product: "Docker Desktop",
        image: "/Users/zach/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
        cpu_pct: 363,
        rss_mb: 9500,
        caps: { cpus: 10, memory_mb: 16384 },
        containers: [
          { name: "determined_cray", image: "zyins:evolve", cpu_pct: 3650.2, mem_mb: 236 },
          { name: "evolve-mysql", image: "mysql:8.0", cpu_pct: 8.4, mem_mb: 413 },
        ],
      }],
    });
    const family = familyNamed(output, "com.apple");
    expect(family).toMatchObject({ verdict: "contention", kind: "vm", remedy: "cap_fan_out" });
    expect(family.evidence.join(" ")).toContain("demand 36.6 cores of its 10 (determined_cray alone 3650.2%)");
    expect(family.advice).toContain("docker update --cpus 5 determined_cray");
  });

  it("names swap, a full disk and an undersized VM in the summary", async () => {
    const { run } = hostWorld();
    const output = await run({
      processes: [proc(20, 1, "com.apple.Virtualization.VirtualMachine", 363, 9500)],
      vms: [{
        pid: 20,
        product: "Docker Desktop",
        image: "/x/Docker.raw",
        cpu_pct: 363,
        rss_mb: 9500,
        caps: { cpus: 10, memory_mb: 16384 },
        containers: [{ name: "build", image: "z:1", cpu_pct: 3650, mem_mb: 236 }],
      }],
      swap: { used_mb: 5560.5, total_mb: 7168, free_mb: 1607.5 },
      disks: [{ mount: "/System/Volumes/Data", size_gb: 3616, used_gb: 3578, free_gb: 38.1, capacity_pct: 99 }],
    });
    expect(output.swap).toEqual({ used_mb: 5560.5, total_mb: 7168, free_mb: 1607.5 });
    expect(output.summary).toContain("Swap 5.4 GB of 7 GB used.");
    expect(output.summary).toContain("Disk /System/Volumes/Data is 99% full (38.1 GB free of 3.5 TB).");
    expect(output.summary).toContain("Docker Desktop VM (pid 20): its containers demand 36.5 cores of the VM's 10.");
  });

  it("leaves swap out of the output when the machine reports none", async () => {
    const { run } = hostWorld();
    const output = await run({ processes: [proc(60, 1, "llama-server -m big.gguf", 4, 9216)] });
    expect("swap" in output).toBe(false);
  });
});

describe("the model step", () => {
  const reply = (rootPid: number): Verdicts => ({
    Verdicts: [{ root_pid: rootPid, verdict: "runaway", remedy: "kill_stale", advice: "kill 50 if the job is stuck", confidence: 0.7 }],
  });

  it("asks about the families the rules cannot settle, and asks again after a wrong root_pid", async () => {
    const { run, prompts } = hostWorld((call) => reply(call === 1 ? 999 : 50));
    const output = await run({ processes: [proc(50, 1, "python3 /opt/odd/job.py", 80, 500)] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("root_pid 999 is not one of the families listed");
    expect(familyNamed(output, "job.py")).toMatchObject({ verdict: "runaway", remedy: "kill_stale", confidence: 0.7 });
  });

  it("keeps a family unknown, with the reason, when the model gives no verdict for it", async () => {
    const { run } = hostWorld(() => ({ Verdicts: [] }));
    const output = await run({ processes: [proc(50, 1, "python3 /opt/odd/job.py", 80, 500)] });
    const family = familyNamed(output, "job.py");
    expect(family).toMatchObject({ verdict: "unknown", confidence: 0 });
    expect(family.evidence.at(-1)).toBe("no rule matched and the model gave no verdict");
    expect(family.remedy).toBeUndefined();
  });

  it("fails, with the last reason, when no attempt is valid", async () => {
    const { run, prompts } = hostWorld(() => ({ Verdicts: [{ root_pid: 50, verdict: "bogus", remedy: "none", advice: "x", confidence: 1 }] }));
    await expect(run({ processes: [proc(50, 1, "python3 /opt/odd/job.py", 80, 500)] })).rejects.toThrow(
      /no valid reply after 3 attempts: verdict "bogus" is not one of/,
    );
    expect(prompts).toHaveLength(3);
  });

  it("shows the model what a VM runs inside when its containers fit the caps", async () => {
    const { run, prompts } = hostWorld(() => ({ Verdicts: [] }));
    await run({
      processes: [proc(20, 1, "com.apple.Virtualization.VirtualMachine", 300, 9000)],
      vms: [{
        pid: 20,
        product: "Docker Desktop",
        image: "/x/Docker.raw",
        cpu_pct: 363,
        rss_mb: 9500,
        caps: { cpus: 10, memory_mb: 16384 },
        containers: [{ name: "build", image: "z:1", cpu_pct: 800, mem_mb: 200 }],
      }],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Host: VM pid 20 Docker Desktop (image /x/Docker.raw)");
    expect(prompts[0]).toContain("10 cpus, 16384 MB, containers: build 800% (200 MB)");
  });

  it("makes no model call when nothing is unsettled", async () => {
    let asked = 0;
    const answers = await askVerdicts([], { loadRatio: 1, ncpu: 4, extras: { disks: [], vms: [] } }, async () => {
      asked += 1;
      return "{}";
    });
    expect(answers.size).toBe(0);
    expect(asked).toBe(0);
  });

  it("validates every field of a reply against the closed lists", () => {
    const listed = new Set([50]);
    const good = { root_pid: 50, verdict: "normal", remedy: "none", advice: "fine", confidence: 0.5 };
    expect(validReply({ Verdicts: [good] }, listed)).toEqual([good]);
    expect(() => validReply({ Verdicts: [{ ...good, root_pid: 51 }] }, listed)).toThrow(/root_pid 51 is not one of the families listed: 50/);
    expect(() => validReply({ Verdicts: [{ ...good, remedy: "reboot" }] }, listed)).toThrow(/remedy "reboot" is not one of/);
    expect(() => validReply({ Verdicts: [{ ...good, verdict: "fine" }] }, listed)).toThrow(/verdict "fine"/);
    expect(() => validReply({ Verdicts: [{ ...good, confidence: 1.5 }] }, listed)).toThrow(/confidence/);
    expect(() => validReply({ Verdicts: [{ ...good, confidence: "high" }] }, listed)).toThrow(/confidence/);
    expect(() => validReply({ Verdicts: [{ ...good, advice: 3 }] }, listed)).toThrow(/advice/);
    expect(() => validReply({ Verdicts: [{ ...good, root_pid: 50.5 }] }, listed)).toThrow(/integer/);
    expect(() => validReply({ Verdicts: [null] }, listed)).toThrow(/object/);
    expect(() => validReply({ Verdicts: "none" }, listed)).toThrow(/Verdicts array/);
    expect(() => validReply(null, listed)).toThrow(/Verdicts array/);
    expect(() => validReply([good], listed)).toThrow(/Verdicts array/);
  });

  it("tells the model the instructions, two examples, the brief and the reply shape", () => {
    const prompt = verdictPrompt("Host: load 1.0 per core (4 cores).");
    expect(prompt).toContain(VERDICT_INSTRUCTIONS);
    expect(prompt.match(/^Example:$/gm)).toHaveLength(2);
    expect(prompt).toContain("Prompt:\nHost: load 1.0 per core (4 cores).");
    expect(prompt).toContain('"Verdicts":[{"root_pid":"integer, one of the listed root_pids"');
    expect(prompt).toContain("scope_hook_to_changed_files | serialize_gates | cap_fan_out | kill_stale | restart_daemon | none");
    expect(verdictBrief([], 1.234, 4)).toBe("Host: load 1.2 per core (4 cores).");
  });
});

describe("omp_model", () => {
  const result = (stdout: string, code = 0, killed = false): ExecResult => ({ stdout, stderr: "", code, killed });

  it("runs `omp -p @<file>` bare, in a private directory that is removed afterwards", async () => {
    const seen: { command: string; args: string[]; cwd?: string; promptFile?: string; prompt?: string }[] = [];
    const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
      const file = args[1]!.slice(1);
      seen.push({ command, args, cwd: options?.cwd, promptFile: file, prompt: await Bun.file(file).text() });
      return result('{"ok":true}');
    };
    const reply = await ompModelStep(exec)("the prompt");
    expect(reply).toBe('{"ok":true}');
    expect(seen[0]!.command).toBe("omp");
    expect(seen[0]!.args.slice(0, 1)).toEqual(["-p"]);
    expect(seen[0]!.args.slice(2)).toEqual([...BARE_OMP_FLAGS]);
    expect(seen[0]!.prompt).toBe("the prompt");
    expect(await Bun.file(seen[0]!.promptFile!).exists()).toBe(false);
  });

  it("names a killed or failing model call", async () => {
    await expect(ompModelStep(async () => result("", -1, true), { timeoutMs: 2000 })("p")).rejects.toThrow(/killed after 2 s/);
    await expect(ompModelStep(async () => ({ stdout: "", stderr: "no key", code: 1, killed: false }))("p")).rejects.toThrow(/exited 1: no key/);
    await expect(ompModelStep(async () => result("  "))("p")).rejects.toThrow(/no text/);
  });

  it("reads a fenced JSON reply and refuses prose", async () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("Sure! Here it is: {}")).toThrow(/not JSON/);
    const replies = ["not json", '{"Verdicts":[]}'];
    const asked: string[] = [];
    const value = await askJson(
      async (prompt) => {
        asked.push(prompt);
        return replies.shift()!;
      },
      "q",
      (reply) => reply,
    );
    expect(value).toEqual({ Verdicts: [] });
    expect(asked[1]).toContain("Your previous reply was rejected");
  });
});

describe("family_context and process_command", () => {
  it.each([
    ["dprint check", { invoked_files: 0, whole_tree: true }],
    ["go test ./...", { invoked_files: 0, whole_tree: true }],
    ["eslint --fix src/a.ts src/b.ts", { invoked_files: 2, whole_tree: false }],
    ["prettier --check src/*.ts", { invoked_files: 0, whole_tree: true }],
    ["hk run pre-push origin https://github.com/o/r", { invoked_files: 0, whole_tree: false }],
    ["hk run pre-commit --all", { invoked_files: 0, whole_tree: true }],
  ])("scopeOf reads %s", (command, scope) => {
    expect(scopeOf(command)).toEqual(scope);
  });

  it.each([
    ["go test ./...", "test"],
    ["go build ./cmd/x", "build"],
    ["go env", "other"],
    ["git push origin main", "git"],
    ["node /repo/node_modules/.bin/vitest run", "test"],
    ["node /repo/scripts/bundle-cli.mjs --bundle", "build"],
    ["node /opt/mcp-server/index.js", "mcp"],
    ["/Applications/Cursor.app/Contents/MacOS/Cursor", "harness"],
    ["/System/Library/Frameworks/CoreServices.framework/mdworker_shared -s mdworker", "indexer"],
    ["/usr/libexec/UserEventAgent", "other"],
  ])("kindOf sorts %s as %s", (command, kind) => {
    expect(kindOf(command)).toBe(kind);
  });
});

const HEADER = "  PID  PPID  %CPU    RSS     ELAPSED      TIME USER             COMMAND";
const PS = "ps -axo pid,ppid,pcpu,rss,etime,cputime,user,command";
const GATHER_REPO = "/work/repo";
const WINDOW_S = 5;
const START_MS = 1_000_000_000;
const BOOT_SECONDS = 999_000;

const FIRST_SAMPLE = [
  HEADER,
  "  100     1   2.0  10240    01:00:00   0:10.00 zach             node build.js --bundle",
  "  300     1   0.0   2048    01:00:00   0:00.10 zach             /usr/bin/idle",
  `  400     1   9.9   1024       00:01   0:00.50 zach             ${PS}`,
].join("\n");
const SECOND_SAMPLE = [
  HEADER,
  "  100     1   2.0  10240  1-01:00:05   0:15.00 zach             node build.js --bundle",
  "  200   100   7.5  99328       00:03   0:00.30 zach             /Applications/Some App.app/Contents/MacOS/Some App",
  "  300     1   0.0   2048    01:00:05   0:00.10 zach             /usr/bin/idle",
  `  400     1   9.9   1024       00:01   0:00.60 zach             ${PS}`,
].join("\n");

class StillClock implements HostClock {
  private ms = START_MS;
  readonly slept: number[] = [];
  now = (): Date => new Date(this.ms);
  sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
    this.ms += ms;
  };
}

const plainMachine = () =>
  new FakeMachine(
    {
      commands: {
        "sysctl -n hw.ncpu": ok("10\n"),
        "sysctl -n vm.loadavg": ok("{ 3.00 2.00 1.00 }\n"),
        "sysctl -n kern.boottime": ok(`{ sec = ${BOOT_SECONDS}, usec = 0 } Thu Oct 15 08:31:17 2026\n`),
        memory_pressure: ok("The system has 17179869184 bytes.\nSystem-wide memory free percentage: 62%\n"),
        "lsof -a -p 100 -d cwd -Fn": ok(`p100\nfcwd\nn${GATHER_REPO}\n`),
        "lsof -a -p 200 -d cwd -Fn": { code: 1, stdout: "", stderr: "no such process" },
        [`git -C ${GATHER_REPO} rev-parse --show-toplevel`]: ok(`${GATHER_REPO}\n`),
      },
      files: { [`${GATHER_REPO}/lefthook.yml`]: "pre-push: {}" },
    },
    [FIRST_SAMPLE, SECOND_SAMPLE],
  );

const VIRTUAL_MACHINE =
  "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/"
  + "com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine";
const VM_PID = 500;
const RAW_IMAGE = "/Users/zach/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw";
const STATS_KEY = ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"].join(" ");
const PS_KEY = ["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"].join(" ");
const SETTINGS_PATH = "/home/zach/Library/Group Containers/group.com.docker/settings-store.json";

const vmSample = (cputime: string): string =>
  [
    HEADER,
    `  ${VM_PID}     1 363.2 10485760    01:00:00   ${cputime} zach             ${VIRTUAL_MACHINE}`,
    `  400     1   9.9   1024       00:01   0:00.50 zach             ${PS}`,
  ].join("\n");

const vmMachine = () =>
  new FakeMachine(
    {
      commands: {
        "sysctl -n hw.ncpu": ok("10\n"),
        "sysctl -n vm.loadavg": ok("{ 401.77 376.05 421.25 }\n"),
        "sysctl -n kern.boottime": ok(`{ sec = ${BOOT_SECONDS}, usec = 0 } Thu Oct 15 08:31:17 2026\n`),
        "sysctl -n vm.swapusage": ok("total = 7168.00M  used = 5560.50M  free = 1607.50M  (encrypted)\n"),
        "df -k -P / /System/Volumes/Data": ok(
          [
            "Filesystem 1024-blocks Used Available Capacity Mounted on",
            "/dev/disk3s1s1 3791857600 12582912 39902044 24% /",
            "/dev/disk3s5 3791857600 3867480064 39902044 99% /System/Volumes/Data",
          ].join("\n") + "\n",
        ),
        memory_pressure: ok("System-wide memory free percentage: 74%\n"),
        [`lsof -a -p ${VM_PID} -d cwd -Fn`]: { code: 1, stdout: "", stderr: "denied" },
        [`lsof -p ${VM_PID}`]: ok(
          [
            `com.apple ${VM_PID} zach 6u REG 1,13 63999836160 881029657 ${RAW_IMAGE}`,
            `com.apple ${VM_PID} zach 7r REG 1,13 580079616 1138661853 /Applications/Docker.app/Contents/Resources/linuxkit/desktop.img`,
          ].join("\n") + "\n",
        ),
        [STATS_KEY]: ok(
          [
            "determined_cray\t3650.18%\t235.7MiB / 15.6GiB",
            "evolve-mysql\t8.36%\t413MiB / 15.6GiB",
            "nq-pg-5432\t0.81%\t110.3MiB / 15.6GiB",
          ].join("\n") + "\n",
        ),
        [PS_KEY]: ok(
          ["nq-pg-5432\tpostgres:16", "determined_cray\tecr.example/zyins:evolve-7879", "evolve-mysql\tmysql:8.0"].join("\n") + "\n",
        ),
      },
      files: { [SETTINGS_PATH]: '{"Cpus":10,"MemoryMiB":16384,"SwapMiB":1024}' },
    },
    [vmSample("0:40.00"), vmSample("0:58.15")],
  );

describe("the gatherer", () => {
  it("measures CPU over the window and reads the rest of the host", async () => {
    const clock = new StillClock();
    const snapshot = await gatherSnapshot(plainMachine(), { top: 1, window_s: WINDOW_S }, clock);
    expect(clock.slept).toEqual([WINDOW_S * 1000]);
    const byPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
    expect(byPid.get(100)).toMatchObject({ cpu_pct: 100, rss_mb: 10, age_s: 90005, ppid: 1, user: "zach" });
    expect(byPid.get(200)).toMatchObject({ cpu_pct: 7.5, rss_mb: 97, command: "/Applications/Some App.app/Contents/MacOS/Some App" });
    expect(byPid.get(300)?.cpu_pct).toBe(0);
    expect(snapshot.processes.map((process) => process.pid)).toEqual([100, 200, 300]);
    expect(snapshot).toMatchObject({
      ncpu: 10,
      load: { avg1: 3, avg5: 2, avg15: 1 },
      memory_pressure: "System-wide memory free percentage: 62%",
      uptime_s: 1000 + WINDOW_S,
      taken_at: new Date(START_MS + WINDOW_S * 1000).toISOString(),
    });
  });

  it("looks up only the heaviest pids and reads the hook config of their repository", async () => {
    const fake = plainMachine();
    const snapshot = await gatherSnapshot(fake, { top: 1, window_s: WINDOW_S }, new StillClock());
    expect(snapshot.cwd).toEqual({ "100": GATHER_REPO });
    expect(snapshot.repo).toEqual({ [GATHER_REPO]: GATHER_REPO });
    expect(snapshot.hook_config).toEqual({ [GATHER_REPO]: `${GATHER_REPO}/lefthook.yml` });
    expect(fake.runs.filter((line) => line.startsWith("lsof")).sort()).toEqual(["lsof -a -p 100 -d cwd -Fn", "lsof -a -p 200 -d cwd -Fn"]);
  });

  it("names the command that failed", async () => {
    const broken = new FakeMachine({ commands: { [PS]: { code: 1, stdout: "", stderr: "denied" } } });
    await expect(gatherSnapshot(broken, { top: 1, window_s: 1 }, new StillClock())).rejects.toThrow(`\`${PS}\` failed (exit 1): denied`);
  });

  it("refuses a CPU count that is not a positive integer instead of dividing the load by it", async () => {
    // The source took Number("") = 0 or NaN straight into the load ratio.
    const fake = new FakeMachine(
      { commands: { "sysctl -n hw.ncpu": ok("\n") } },
      [FIRST_SAMPLE, SECOND_SAMPLE],
    );
    await expect(gatherSnapshot(fake, { top: 1, window_s: 1 }, new StillClock())).rejects.toThrow(/not a CPU count/);
  });

  it("reads etime and cputime with days, hours and fractions", () => {
    expect(secondsOf("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(secondsOf("04:05")).toBe(245);
    expect(secondsOf("0:00.50")).toBe(0.5);
    expect(secondsOf("1:28.15")).toBe(88.15);
  });

  it("reads swap, disk capacity and what a Docker VM runs inside", async () => {
    const snapshot = await gatherSnapshot(vmMachine(), { top: 1, window_s: WINDOW_S }, new StillClock());
    expect(snapshot.swap).toEqual({ total_mb: 7168, used_mb: 5560.5, free_mb: 1607.5 });
    expect(snapshot.disks).toEqual([
      { mount: "/System/Volumes/Data", size_gb: 3616.2, used_gb: 3688.3, free_gb: 38.1, capacity_pct: 99 },
      { mount: "/", size_gb: 3616.2, used_gb: 12, free_gb: 38.1, capacity_pct: 24 },
    ]);
    expect(snapshot.vms).toEqual([{
      pid: VM_PID,
      product: "Docker Desktop",
      image: RAW_IMAGE,
      cpu_pct: 363,
      rss_mb: 10240,
      caps: { cpus: 10, memory_mb: 16384 },
      containers: [
        { name: "determined_cray", image: "ecr.example/zyins:evolve-7879", cpu_pct: 3650.2, mem_mb: 235.7 },
        { name: "evolve-mysql", image: "mysql:8.0", cpu_pct: 8.4, mem_mb: 413 },
        { name: "nq-pg-5432", image: "postgres:16", cpu_pct: 0.8, mem_mb: 110.3 },
      ],
    }]);
  });

  it("leaves swap, disks and vms out when the machine reports none", async () => {
    const snapshot = await gatherSnapshot(plainMachine(), { top: 1, window_s: WINDOW_S }, new StillClock());
    expect(snapshot.swap).toBeUndefined();
    expect(snapshot.disks).toEqual([]);
    expect(snapshot.vms).toEqual([]);
  });

  it("parses swap in gigabytes and skips df headers", () => {
    expect(swapOf("total = 2.00G  used = 1.50G  free = 500.00M")).toEqual({ total_mb: 2048, used_mb: 1536, free_mb: 500 });
    expect(swapOf("swap: none")).toBeUndefined();
    expect(diskRow("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBeUndefined();
    expect(diskRow("/dev/disk1 1024 512 512 50% /mnt/with spaces")).toEqual({
      mount: "/mnt/with spaces",
      size_gb: 0,
      used_gb: 0,
      free_gb: 0,
      capacity_pct: 50,
    });
  });

  it("only ever runs read commands", async () => {
    const fake = vmMachine();
    await gatherSnapshot(fake, { top: 1, window_s: 1 }, new StillClock());
    const commands = new Set(fake.runs.map((line) => line.split(" ")[0]));
    expect([...commands].sort()).toEqual(["df", "docker", "git", "lsof", "memory_pressure", "ps", "sysctl"].filter((name) => commands.has(name)));
    for (const line of fake.runs.filter((entry) => entry.startsWith("docker"))) expect(line).toMatch(/^docker (stats|ps) /);
  });
});

describe("a recorded snapshot of a loaded Mac", () => {
  it("is judged without error: every examined family has a verdict, and the heaviest are named", async () => {
    const recorded = (await Bun.file(new URL("./snapshot-2026-10-15.json", import.meta.url)).json()) as HostSnapshot;
    const snapshot: HostSnapshot = { ...recorded, disks: recorded.disks ?? [], vms: recorded.vms ?? [] };
    // Every family the rules leave unsettled gets one model answer: "normal", so the run needs no real model.
    const model = scripted((_call, prompt) => ({
      Verdicts: listedPids(prompt).map((pid) => ({
        root_pid: pid,
        verdict: "normal",
        remedy: "none",
        advice: "recorded run",
        confidence: 0.5,
      })),
    }));
    const output = await analyzeHost(snapshot, { top: 5, include_normal: true }, model.step);
    expect(output.load.ncpu).toBe(10);
    expect(output.load.ratio).toBe(9.48);
    expect(output.families.length).toBeGreaterThan(0);
    expect(output.families.length).toBeLessThanOrEqual(10);
    for (const family of output.families) {
      expect(["normal", "overscoped", "runaway", "contention", "unknown"]).toContain(family.verdict);
      expect(family.evidence.length).toBeGreaterThan(0);
    }
    const weights = output.families.map((family) => family.cpu_pct + family.rss_mb / 1024);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(output.summary).toStartWith("Load 9.48 per core (avg1 94.83 on 10 cores).");
    expect(model.prompts.length).toBeLessThanOrEqual(1);
  });
});

/** A `pi` whose `zod` accepts any chain of builder calls; the real omptype is checked outside the suite. */
function stubPi(exec: (command: string, args: string[], options?: unknown) => Promise<unknown>) {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return { zod: new Proxy({}, { get: () => chain }), exec, cwd: "/work" } as unknown as Parameters<typeof buildTool>[0];
}

describe("the tool", () => {
  it("runs the whole default path through pi.exec: two ps samples, the host reads, then one omp -p model call", async () => {
    const machine = plainMachine();
    const commands: { command: string; cwd?: string; timeout?: number }[] = [];
    const exec = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      commands.push({ command, cwd: options?.cwd, timeout: options?.timeout });
      if (command === "omp") {
        const prompt = await Bun.file(args[1]!.slice(1)).text();
        const pid = listedPids(prompt)[0];
        const verdicts = pid === undefined ? [] : [{ root_pid: Number(pid), verdict: "runaway", remedy: "kill_stale", advice: "kill it", confidence: 0.6 }];
        return { stdout: JSON.stringify({ Verdicts: verdicts }), stderr: "", code: 0, killed: false };
      }
      const result = await machine.run(command, args);
      return { ...result, killed: false };
    };
    const tool = buildTool(stubPi(exec), { clock: new StillClock() });
    const updates: string[] = [];
    const result = await tool.execute(
      "id",
      { top: 1, window_s: WINDOW_S, include_normal: true },
      (partial) => updates.push(partial.content[0]!.text),
      undefined,
      undefined,
    );
    expect(commands.filter((entry) => entry.command === "ps")).toHaveLength(2);
    expect(commands.filter((entry) => entry.command === "omp").length).toBeLessThanOrEqual(1);
    for (const entry of commands.filter((e) => e.command !== "omp")) {
      expect(entry).toMatchObject({ cwd: "/work", timeout: 30_000 });
    }
    expect(result.details.load).toMatchObject({ ncpu: 10, ratio: 0.3 });
    expect(result.content[0]!.text.startsWith(`${result.details.summary}\n`)).toBe(true);
    expect(JSON.parse(result.content[0]!.text.split("\n")[1]!)).toEqual(result.details);
    expect(updates).toContain("host_bottlenecks: judging process families");
  });

  it("uses the defaults for absent and null fields", async () => {
    const seen: { top: number; window_s: number }[] = [];
    const tool = buildTool(stubPi(async () => ({})), {
      gather: async (request) => {
        seen.push(request);
        return snapshotOf({ processes: [proc(60, 1, "llama-server -m big.gguf", 4, 9216)] });
      },
      step: scripted().step,
    });
    await tool.execute("id", {}, undefined, undefined, undefined);
    await tool.execute("id", { top: null, window_s: null, include_normal: null }, undefined, undefined, undefined);
    expect(seen).toEqual([{ top: 10, window_s: 5 }, { top: 10, window_s: 5 }]);
  });

  it("lists normal families in `families` only when asked", async () => {
    const tool = buildTool(stubPi(async () => ({})), {
      gather: async () => snapshotOf({ processes: [proc(60, 1, "llama-server -m big.gguf", 4, 9216)] }),
      step: scripted().step,
    });
    const quiet = await tool.execute("id", {}, undefined, undefined, undefined);
    const all = await tool.execute("id", { include_normal: true }, undefined, undefined, undefined);
    expect(quiet.details.families).toEqual([]);
    expect(quiet.details.normal.map((family) => family.name)).toContain("llama-server");
    expect(all.details.families.map((family) => family.name)).toContain("llama-server");
  });

  it("fails the call when the model gives no valid reply, rather than returning a half answer", async () => {
    const tool = buildTool(stubPi(async () => ({})), {
      gather: async () => snapshotOf({ processes: [proc(50, 1, "python3 /opt/odd/job.py", 80, 500)] }),
      step: async () => "not json",
    });
    await expect(tool.execute("id", {}, undefined, undefined, undefined)).rejects.toThrow(/no valid reply after 3 attempts/);
  });

  it("clears its heartbeat timer, success or failure", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let started = 0;
    let cleared = 0;
    globalThis.setInterval = ((handler: () => void) => {
      started += 1;
      handler();
      return 1;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {
      cleared += 1;
    }) as unknown as typeof clearInterval;
    try {
      const ok1 = buildTool(stubPi(async () => ({})), { gather: async () => snapshotOf({ processes: [] }), step: scripted().step });
      await ok1.execute("id", {}, () => undefined, undefined, undefined);
      const bad = buildTool(stubPi(async () => ({})), {
        gather: async () => {
          throw new Error("ps failed");
        },
        step: scripted().step,
      });
      await expect(bad.execute("id", {}, () => undefined, undefined, undefined)).rejects.toThrow("ps failed");
      expect([started, cleared]).toEqual([2, 2]);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  it("turns a killed or crashing command into a failed read, and an abort into an abort", async () => {
    const killed = execMachine(stubPi(async () => ({ stdout: "partial", stderr: "", code: 143, killed: true })), undefined);
    expect(await killed.run("docker", ["stats"])).toMatchObject({ code: -1, stderr: "docker timed out after 30 s" });
    const crashed = execMachine(
      stubPi(async () => {
        throw new Error("spawn lsof ENOENT");
      }),
      undefined,
    );
    expect(await crashed.run("lsof", [])).toMatchObject({ code: -1, stderr: "spawn lsof ENOENT" });
    const controller = new AbortController();
    controller.abort();
    const aborted = execMachine(stubPi(async () => ({ stdout: "", stderr: "", code: -1, killed: true })), controller.signal);
    await expect(aborted.run("ps", [])).rejects.toBeDefined();
  });

  it("reads files and reports a missing one as absent", async () => {
    const machine = execMachine(stubPi(async () => ({})), undefined);
    expect(await machine.readTextFile("/definitely/not/here.json")).toBeUndefined();
    expect(await machine.isFile("/definitely/not/here.json")).toBe(false);
    expect(await machine.isFile(new URL(".", import.meta.url).pathname)).toBe(false);
    expect(await machine.isFile(new URL("./index.ts", import.meta.url).pathname)).toBe(true);
  });

  it("renders the summary first and the full report after", () => {
    const output = { summary: "Load 1.00 per core." } as HostBottlenecksOutput;
    expect(renderReport(output)).toBe(`Load 1.00 per core.\n${JSON.stringify(output)}`);
  });

  it("has the shape of a custom tool and a description in the house style", () => {
    const tool = buildTool(stubPi(async () => ({})));
    expect(tool.name).toBe("host_bottlenecks");
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("NEVER kills, caps or restarts");
    expect(DESCRIPTION).toContain("`unknown`");
  });
});
