import { describe, expect, it } from "bun:test";
import type { ResearchDeps } from "./advisory_sources.ts";
import { FakeMachine, ok } from "./fake_machine.ts";
import {
  checkedProfile,
  checkedResults,
  factsFor,
  factsOf,
  packageNamesOf,
  verdictOf,
} from "./judgment.ts";
import { FACTS, type Fact } from "./inventory_facts.ts";
import type { ProcessResult } from "./machine.ts";
import { languagePrompt, questionOf } from "./question.ts";
import { ASSETS_AT_ONCE, runRiskCheck } from "./risk_check.ts";
import { DESCRIPTION, makeTool, runWithPi } from "./tool.ts";
import type { AdvisoryProfile, AdvisorySource, ConditionResult } from "./types.ts";
import { loadZod } from "./zod_for_tests.ts";

const NONCE = "n0nce";
const SITES = "/home/zach/Developer/Zysys/webmaster/sites";

/** A made-up advisory shaped like the canary: a login bypass in an SSH daemon on musl systems without PAM. */
const SOURCES: AdvisorySource[] = [{
  url: "https://advisory.example/",
  kind: "page",
  status: 200,
  text: "sshd on musl without PAM accepts any 257 to 1024 character password for an account whose shadow entry is `*`. Fixed in openssh 10.6p2.",
}];

const PROFILE: AdvisoryProfile = {
  title: "sshd accepts a long password for a starred account on musl",
  summary: "On musl systems with no PAM, sshd lets a password of 257 to 1024 characters into any account whose shadow field is a bare star.",
  severity: "high",
  cves: [],
  applies_to: ["server"],
  components: [{ name: "OpenSSH", package_names: ["openssh-server", "openssh"], affected: "before 10.6p2", fixed_in: "10.6p2" }],
  conditions: [
    { id: "musl_libc", statement: "The system runs musl libc.", facts: ["libc"], necessary: true },
    { id: "no_pam", statement: "sshd is not linked to PAM.", facts: ["sshd_links_pam"], necessary: true },
    { id: "password_login", statement: "Password logins are enabled.", facts: ["sshd_config"], necessary: true },
    { id: "old_openssh", statement: "The installed OpenSSH is older than 10.6p2.", facts: ["packages"], necessary: true },
    { id: "star_account", statement: "An account has a bare `*` password.", facts: ["shadow_states"], necessary: true },
  ],
  compromise_indicators: ["An auth.log line accepting a password for an account that has none."],
  workaround: ["Set PasswordAuthentication no and restart sshd."],
  remediation: ["Upgrade OpenSSH to 10.6p2 or later."],
  confidence: "high",
  gaps: [],
};

const ALPINE: Partial<Record<Fact, string>> = {
  libc: "musl libc (x86_64)\nVersion 1.2.5\n/lib/ld-musl-x86_64.so.1",
  sshd_links_pam: "no PAM library linked",
  sshd_config: "effective settings unreadable: sshd -T needs root\nconfig files:\n/etc/ssh/sshd_config:PasswordAuthentication yes",
  packages: "openssh-server-10.0_p1-r9 x86_64 {openssh} (BSD) [installed]",
  shadow_states: "star_accounts: alpine root\nhashed_accounts:1\nlocked_accounts:0",
};
const DEBIAN: Partial<Record<Fact, string>> = {
  libc: "ldd (Debian GLIBC 2.36-9+deb12u7) 2.36",
  sshd_links_pam: "\tlibpam.so.0 => /lib/x86_64-linux-gnu/libpam.so.0 (0x00007f)",
  sshd_config: "effective (sshd -T):\nusepam yes\npasswordauthentication yes",
  packages: "openssh-server 1:9.2p1-2+deb12u3",
  shadow_states: "star_accounts: daemon bin\nhashed_accounts:2\nlocked_accounts:0",
};

const SSH_CONFIG = "Host alpine\n  HostName 192.0.2.10\nHost debian\n  HostName 192.0.2.11\nHost down\n  HostName 192.0.2.12\n";
const FACTS_BY_TARGET: Record<string, Partial<Record<Fact, string>> | "down"> = { alpine: ALPINE, debian: DEBIAN, down: "down" };

/** A machine that lists three servers and one site and answers each SSH read with the sections a host would print. */
class World extends FakeMachine {
  override async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.runs.push({ commandLine: [command, ...args].join(" ") });
    if (command === "ssh" && args[0] === "-G") {
      return ok(`user ops\nhostname 192.0.2.${args[1] === "alpine" ? 10 : args[1] === "debian" ? 11 : 12}\nport 22\n`);
    }
    const target = args.at(-2) ?? "";
    const facts = FACTS_BY_TARGET[target];
    if (facts === "down" || facts === undefined) return { code: 255, stdout: "", stderr: "Permission denied (publickey)." };
    const stdout = Object.entries(facts)
      .map(([fact, output]) => `@@${NONCE}:begin:${fact}\n${output}\n@@${NONCE}:end:${fact}:0`)
      .join("\n");
    return ok(stdout);
  }
}

const world = (): World =>
  new World({
    files: {
      "/home/zach/.ssh/config": SSH_CONFIG,
      [`${SITES}/example.yaml`]: "url: https://www.example.test/\nplatform: wordpress\n",
    },
  });

type Row = readonly [ConditionResult["result"], Fact | null, string];
const result = (condition: string, [outcome, fact, quote]: Row): ConditionResult => ({
  condition,
  result: outcome,
  fact,
  quote,
  note: `${condition} is ${outcome}`,
});

/** What an honest model answers for each asset, quoting the facts the host read. */
const HONEST: Record<string, Record<string, Row>> = {
  "server:alpine": {
    musl_libc: ["met", "libc", "musl libc (x86_64)"],
    no_pam: ["met", "sshd_links_pam", "no PAM library linked"],
    password_login: ["met", "sshd_config", "PasswordAuthentication yes"],
    old_openssh: ["met", "packages", "openssh-server-10.0_p1-r9"],
    star_account: ["met", "shadow_states", "star_accounts: alpine root"],
  },
  "server:debian": {
    musl_libc: ["not_met", "libc", "Debian GLIBC 2.36"],
    no_pam: ["not_met", "sshd_links_pam", "libpam.so.0"],
    password_login: ["met", "sshd_config", "passwordauthentication yes"],
    old_openssh: ["met", "packages", "openssh-server 1:9.2p1"],
    star_account: ["met", "shadow_states", "star_accounts: daemon bin"],
  },
};

/** The asset the prompt asks about: its last heading, since the question's own example has one too. */
const assetOf = (prompt: string): string => [...prompt.matchAll(/## Asset: (\S+)/g)].at(-1)?.[1] ?? "";

class ScriptedModel {
  readonly prompts: string[] = [];
  constructor(private readonly answer: (kind: "Profile" | "Conditions", prompt: string) => unknown = honest) {}
  readonly step = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    this.prompts.push(prompt);
    const kind = prompt.startsWith("## Profile\n") ? "Profile" : "Conditions";
    return JSON.stringify({ [kind]: this.answer(kind, prompt) });
  };
}

function honest(kind: "Profile" | "Conditions", prompt: string): unknown {
  if (kind === "Profile") return PROFILE;
  const rows = HONEST[assetOf(prompt)] ?? {};
  return PROFILE.conditions.map((condition) => result(condition.id, rows[condition.id] ?? ["unknown", null, ""]));
}

const research: ResearchDeps = {
  fetchPage: async (url) => ({ status: 200, contentType: "text/plain", body: `advisory text for ${url}` }),
  search: async () => {
    throw new Error("no search expected");
  },
};

const run = (request: Parameters<typeof runRiskCheck>[0], model = new ScriptedModel(), machine: FakeMachine = world(), deps: ResearchDeps = research) =>
  runRiskCheck(request, { machine, model: model.step, research: deps, inventory: { nonce: () => NONCE, now: () => "2026-11-05T00:00:00.000Z" } });

describe("runRiskCheck on the canary shape (musl, no PAM, starred account, password login)", () => {
  it("calls the vulnerable server affected, the glibc one safe, the unreachable one unmeasured, and the site not applicable", async () => {
    const model = new ScriptedModel();
    const output = await run({ text: "sshhole.com" }, model);
    expect(output.assets.map(({ asset, verdict }) => `${asset} ${verdict}`).sort()).toEqual([
      "server:alpine affected",
      "server:debian not_affected",
      "server:down unmeasured",
      "site:example not_applicable",
    ]);
    expect(output.counts).toEqual({ affected: 1, not_affected: 1, unmeasured: 1, not_applicable: 1 });
    expect(output.headline).toBe("1 affected, 1 unmeasured, 1 not affected, 1 not applicable, across 4 assets");
    expect(output.assets.map((verdict) => verdict.verdict)).toEqual(["affected", "unmeasured", "not_affected", "not_applicable"]);
    expect(output.unmeasured).toEqual([{ asset: "server:down", reason: expect.stringContaining("Permission denied") }]);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toMatchObject({ severity: "high" });
    expect(JSON.stringify(output.findings[0])).toContain("star_accounts: alpine root");
    expect(output.advisory.title).toBe(PROFILE.title);
    expect(output.sources).toEqual([{ url: "https://sshhole.com/", kind: "page", status: 200 }]);
    // one profile question plus one conditions question for each of the two readable servers; the site and the down server cost none
    expect(model.prompts.filter((prompt) => prompt.startsWith("## Profile\n"))).toHaveLength(1);
    expect(model.prompts.filter((prompt) => prompt.startsWith("## Conditions\n"))).toHaveLength(2);
  });

  it("reads only fixed read-only facts: the SSH sessions it ran are the fact script, never a command from the model or the owner's words", async () => {
    const machine = world();
    await run({ text: "sshhole.com" }, new ScriptedModel(), machine);
    const sessions = machine.runs.map((entry) => entry.commandLine).filter((line) => line.startsWith("ssh ") && !line.startsWith("ssh -G"));
    expect(sessions).toHaveLength(3);
    for (const line of sessions) {
      expect(line).not.toContain("sshhole");
      expect(line).toContain("base64 -d | sh");
    }
  });

  it("checks only the servers and sites the caller names", async () => {
    const output = await run({ text: "sshhole.com", servers: ["alpine"], sites: [] });
    expect(output.assets.map((verdict) => verdict.asset)).toEqual(["server:alpine"]);
  });

  it("never counts an asset safe when the model's answer cannot be judged: a forged quote leaves it unmeasured", async () => {
    const forged = new ScriptedModel((kind, prompt) => {
      if (kind === "Profile") return PROFILE;
      return PROFILE.conditions.map((condition) => result(condition.id, ["met", PROFILE.conditions.find((c) => c.id === condition.id)!.facts[0]!, `invented ${assetOf(prompt)}`]));
    });
    const output = await run({ text: "sshhole.com", servers: ["alpine"], sites: [] }, forged);
    expect(output.assets[0]).toMatchObject({ asset: "server:alpine", verdict: "unmeasured" });
    expect(output.assets[0]!.reason).toContain("could not be judged");
    // each bad reply is asked again with its reason, then given up: 3 attempts
    expect(forged.prompts.filter((prompt) => prompt.startsWith("## Conditions\n"))).toHaveLength(3);
  });

  it("fails, naming the cause, when nothing about the advisory could be read", async () => {
    const model = new ScriptedModel();
    const failing: ResearchDeps = {
      fetchPage: async () => {
        throw new Error("ENOTFOUND");
      },
      search: async () => [],
    };
    await expect(run({ text: "sshhole.com" }, model, world(), failing)).rejects.toThrow(/nothing could be read about "sshhole.com": https:\/\/sshhole.com\/: ENOTFOUND/);
    expect(model.prompts).toHaveLength(0);
  });

  it("fails when there is nothing to check", async () => {
    await expect(run({ text: "sshhole.com", servers: ["nope"], sites: ["nope"] })).rejects.toThrow(/no servers or sites to check/);
  });

  it("stops at once when cancelled before anything is read", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRiskCheck({ text: "sshhole.com" }, { machine: world(), model: new ScriptedModel().step, research, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("reads at most a few assets at once", () => {
    expect(ASSETS_AT_ONCE).toBeGreaterThanOrEqual(1);
  });
});

const IDS = PROFILE.conditions.map((condition) => condition.id);
const verdictResult = (condition: string, outcome: ConditionResult["result"], extra: Partial<ConditionResult> = {}): ConditionResult => ({
  condition,
  result: outcome,
  fact: outcome === "unknown" ? null : "libc",
  quote: outcome === "unknown" ? "" : "musl libc",
  note: "because",
  ...extra,
});
const all = (outcome: ConditionResult["result"], except: Record<string, ConditionResult["result"]> = {}) =>
  IDS.map((id) => verdictResult(id, except[id] ?? outcome));

describe("verdictOf: the verdict follows from the conditions, never from the model's say-so", () => {
  it("is affected only when every necessary condition holds", () => {
    expect(verdictOf(PROFILE, all("met")).verdict).toBe("affected");
  });

  it("clears an asset when one necessary condition is not met, even if another is unknown", () => {
    const verdict = verdictOf(PROFILE, all("met", { musl_libc: "not_met", star_account: "unknown" }));
    expect(verdict.verdict).toBe("not_affected");
    expect(verdict.reason).toContain("musl_libc");
  });

  it("leaves an asset unmeasured, never safe, when a necessary condition is unknown and none fails", () => {
    const verdict = verdictOf(PROFILE, all("met", { star_account: "unknown" }));
    expect(verdict.verdict).toBe("unmeasured");
    expect(verdict.reason).toContain("star_account");
  });

  it("ignores a condition that is not necessary", () => {
    const profile = {
      ...PROFILE,
      conditions: [...PROFILE.conditions, { id: "extra", statement: "Makes it worse.", facts: ["kernel" as const], necessary: false }],
    };
    expect(verdictOf(profile, [...all("met"), verdictResult("extra", "not_met")]).verdict).toBe("affected");
  });
});

describe("checkedResults: a model cannot settle a condition with words that are not in the facts", () => {
  const facts = factsOf({
    status: "measured",
    measured_at: "2026-11-05T00:00:00.000Z",
    facts: Object.entries(ALPINE).map(([fact, output]) => ({ fact: fact as Fact, command_line: fact, code: 0, output: output! })),
  });
  const quotes: Record<string, string> = {
    musl_libc: "musl libc",
    no_pam: "no PAM library linked",
    password_login: "PasswordAuthentication yes",
    old_openssh: "openssh-server-10.0_p1-r9",
    star_account: "star_accounts: alpine root",
  };
  const quoted = all("met").map((each, index) => ({ ...each, fact: PROFILE.conditions[index]!.facts[0]!, quote: quotes[each.condition]! }));

  it("accepts a quote copied from the fact it names, whatever the line wrapping", () => {
    expect(checkedResults(PROFILE, facts, quoted)).toHaveLength(5);
    const wrapped = quoted.map((each) => (each.condition === "musl_libc" ? { ...each, quote: "musl libc\n  (x86_64)" } : each));
    expect(checkedResults(PROFILE, facts, wrapped)).toHaveLength(5);
  });

  it("refuses a quote that is not in the output", () => {
    const forged = quoted.map((each) => (each.condition === "musl_libc" ? { ...each, quote: "musl libc 1.2.9" } : each));
    expect(() => checkedResults(PROFILE, facts, forged)).toThrow(/musl_libc.*not in the output/);
  });

  it("refuses met or not_met that names a fact which was never read", () => {
    const unread = quoted.map((each) => (each.condition === "no_pam" ? { ...each, fact: "kernel" as const } : each));
    expect(() => checkedResults(PROFILE, facts, unread)).toThrow(/no_pam.*kernel.*was not read/);
  });

  it("refuses results out of order or missing, and an unknown with no note", () => {
    expect(() => checkedResults(PROFILE, facts, quoted.slice(1))).toThrow(/one result per condition/);
    expect(() => checkedResults(PROFILE, facts, [...quoted].reverse())).toThrow(/in this order/);
    const mute = quoted.map((each, index) => (index === 0 ? verdictResult(each.condition, "unknown", { note: " " }) : each));
    expect(() => checkedResults(PROFILE, facts, mute)).toThrow(/say in note what is missing/);
  });
});

describe("checkedProfile", () => {
  it("refuses a profile whose conditions are all optional, since no asset could then be judged", () => {
    const optional = { ...PROFILE, conditions: PROFILE.conditions.map((condition) => ({ ...condition, necessary: false })) };
    expect(() => checkedProfile(optional)).toThrow(/at least one necessary condition/);
  });

  it("refuses a repeated condition id", () => {
    const twice = { ...PROFILE, conditions: [PROFILE.conditions[0]!, PROFILE.conditions[0]!] };
    expect(() => checkedProfile(twice)).toThrow(/used twice/);
  });

  it("refuses a packages condition when no component names a package", () => {
    const bare = { ...PROFILE, components: PROFILE.components.map((component) => ({ ...component, package_names: [] })) };
    expect(() => checkedProfile(bare)).toThrow(/old_openssh.*no component names a package/);
  });
});

describe("what is read from each asset", () => {
  it("reads the facts the conditions name plus a baseline, only those that exist for the asset's kind", () => {
    expect(factsFor(PROFILE, "server")).toEqual(["os_release", "kernel", "libc", "sshd_links_pam", "sshd_config", "packages", "shadow_states"]);
    expect(factsFor(PROFILE, "site")).toEqual(["web_headers"]);
  });

  it("names each package once", () => {
    expect(packageNamesOf(PROFILE)).toEqual(["openssh-server", "openssh"]);
  });
});

describe("the question file", () => {
  it("lets the model choose exactly the facts the inventory can read", () => {
    const enumOf = (schema: unknown): unknown => JSON.stringify(schema).match(/"enum":\[("os_release"[^\]]*)\]/)?.[1];
    const allFacts = FACTS.map((fact) => `"${fact}"`).join(",");
    expect(enumOf(questionOf("Profile").schema)).toBe(allFacts);
    expect(enumOf(questionOf("Conditions").schema)).toBe(`${allFacts},null`);
  });

  it("builds a prompt that begins with the question's heading and ends with the reply schema", () => {
    const prompt = languagePrompt(questionOf("Profile"), "the input");
    expect(prompt.startsWith("## Profile\n")).toBe(true);
    expect(prompt).toContain("Prompt:\nthe input\n");
    expect(prompt).toContain("Respond as JSON matching this schema:");
  });
});

describe("the tool", () => {
  it("returns the result as JSON text and as details, with a heartbeat-free run when no update callback is given", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      machine: () => world(),
      model: new ScriptedModel().step,
      research,
      inventory: { nonce: () => NONCE },
    });
    const out = await tool.execute("id", { text: "  sshhole.com  ", servers: ["alpine"], sites: [] }, undefined as never, undefined);
    expect(out.details.counts.affected).toBe(1);
    expect(JSON.parse(out.content[0]!.text).headline).toBe("1 affected, 0 unmeasured, 0 not affected, 0 not applicable, across 1 assets");
  });

  it("refuses empty words before reading or asking anything", async () => {
    let asked = 0;
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      machine: () => world(),
      model: async () => {
        asked++;
        return "{}";
      },
      research,
    });
    await expect(tool.execute("id", { text: "   " }, undefined as never, undefined)).rejects.toThrow(/the advisory is needed/);
    expect(asked).toBe(0);
  });

  it("takes null for the optional lists", async () => {
    const zod = (await loadZod()) as { object: unknown };
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { machine: () => world(), model: new ScriptedModel().step, research, inventory: { nonce: () => NONCE } });
    expect(zod).toBeDefined();
    const out = await tool.execute("id", { text: "sshhole.com", servers: null, sites: null }, undefined as never, undefined);
    expect(out.details.counts.affected).toBe(1);
  });

  it("passes the command to omp's exec with a timeout and records a stopped command as code -1", async () => {
    const calls: unknown[] = [];
    const pi = {
      cwd: "/tmp",
      exec: async (command: string, args: string[], options: unknown) => {
        calls.push([command, args, options]);
        return args[0] === "slow" ? { code: 0, stdout: "x", stderr: "e", killed: true } : { code: 3, stdout: "out", stderr: "err", killed: false };
      },
    };
    const runner = runWithPi(pi as never);
    expect(await runner("ssh", ["fast"])).toEqual({ code: 3, stdout: "out", stderr: "err" });
    const stopped = await runner("ssh", ["slow"]);
    expect(stopped.code).toBe(-1);
    expect(stopped.stderr).toContain("stopped after");
    expect(calls[0]).toMatchObject(["ssh", ["fast"], { cwd: "/tmp", timeout: 300000 }]);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the gate and the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("WEBMASTER_SECURITY_SERVER=0");
    expect(DESCRIPTION).toContain("OPENROUTER_API_KEY");
    expect(DESCRIPTION).toContain("never fixes");
  });
});
