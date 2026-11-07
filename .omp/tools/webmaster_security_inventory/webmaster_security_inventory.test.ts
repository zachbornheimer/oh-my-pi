import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "./asset.ts";
import { type InventoryNet, measureServer, measureSite } from "./asset_inventory.ts";
import { listAssets, narrowAssets, sshHostLines } from "./assets.ts";
import { FakeMachine, ok } from "./fake_machine.ts";
import {
  checkedPackages,
  type FactSection,
  factScript,
  readSections,
  remoteRunner,
  SERVER_FACTS,
  serverCommand,
  SYSCTL_KEYS,
} from "./inventory_facts.ts";
import type { ProcessResult } from "./machine.ts";
import { DESCRIPTION, findAsset, makeTool, runWithPi } from "./tool.ts";
import { SSH_OPTIONS } from "./wp_ssh.ts";
import { loadZod } from "./zod_for_tests.ts";

const server = (name: string, hostname: string): Asset => ({
  kind: "server",
  name,
  target: name,
  hostname,
  port: 22,
  user: "ops",
  aliases: [],
  sites: [],
  source: "ssh_config",
});
const SITE: Asset = { kind: "site", name: "example", url: "https://www.example.test/", platform: "wordpress" };
/** One section of the script's output, as the remote `sh` prints it. */
const sectionText = (nonce: string, fact: string, section: FactSection): string =>
  `@@${nonce}:begin:${fact}\n${section.output}\n@@${nonce}:end:${fact}:${section.code}`;

const NONCE = "n0nce";
const net = (banner: string | Error): InventoryNet => ({
  banner: async () => {
    if (banner instanceof Error) throw banner;
    return banner;
  },
  home: async () => ({ status: 200, headers: { server: "nginx/1.27.0", "x-powered-by": "PHP/8.3" }, body: "<meta name=\"generator\" content=\"WordPress 6.8\">" }),
});

/** The SSH call that reads these facts, as the host machine is asked to run it. */
const sshCall = (target: string, facts: Parameters<typeof factScript>[0]) =>
  `ssh ${SSH_OPTIONS.join(" ")} -o ServerAliveInterval=15 -o ServerAliveCountMax=2 ${target} ${remoteRunner(factScript(facts, NONCE))}`;

describe("package names go into a command line, so only package names may", () => {
  it("refuses anything that could be shell syntax", () => {
    for (const name of ["openssh; rm -rf /", "$(id)", "a b", "Open", "`x`", "../x"]) {
      expect(() => checkedPackages([name])).toThrow(/is not a package name/);
    }
    expect(checkedPackages(["openssh-server", "libstdc++6", "openssh-server"])).toEqual(["openssh-server", "libstdc++6"]);
    expect(() => serverCommand("packages", ["x; id"])).toThrow(/is not a package name/);
  });
});

describe("the packages fact, run by a real sh with the host's package manager stubbed", () => {
  /** A PATH holding only `stubs` (name -> shell body) plus the system tools the command itself needs. */
  function packagesOutput(stubs: Record<string, string>, names: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "pkgs-"));
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    const ran = spawnSync("/bin/sh", ["-c", serverCommand("packages", names)], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    return { code: ran.status, out: ran.stdout.trim() };
  }
  const dpkg = "[ \"$3\" = nginx ] && echo 'nginx 1.24.0-2ubuntu7'; [ \"$3\" = ghost ] && echo 'ghost '; exit 1";

  it("says `not installed: <name>` and exits 0 for a package the host lacks, so absence is not a failed read", () => {
    const { code, out } = packagesOutput({ "dpkg-query": dpkg }, ["nginx", "caddy", "ghost"]);
    expect(code).toBe(0);
    expect(out).toBe("package manager: dpkg\nnginx 1.24.0-2ubuntu7\nnot installed: caddy\nnot installed: ghost");
  });

  it("names the package manager it asked, and uses the first one the host has", () => {
    const rpm = "[ \"$2\" != '--qf' ] || echo 'openssh 9.9p1-13.el9'; exit 0";
    const { out } = packagesOutput({ rpm }, ["openssh"]);
    expect(out).toBe("package manager: rpm\nopenssh 9.9p1-13.el9");
  });

  it("fails visibly, never as `not installed`, when the host has no supported package manager", () => {
    const { code, out } = packagesOutput({}, ["nginx"]);
    expect(code).toBe(3);
    expect(out).toContain("no supported package manager found");
    expect(out).not.toContain("not installed");
  });
});

describe("the kernel_package fact", () => {
  /** A PATH holding only the stubs and the real grep, so the host's own dpkg or rpm can never leak in. */
  function machine(stubs: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "kpkg-"));
    const grep = spawnSync("/bin/sh", ["-c", "command -v grep"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(grep, join(dir, "grep"));
    stubs.uname ??= "echo 6.8.0-139-generic";
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  }
  const run = (path: string) =>
    spawnSync("/bin/sh", ["-c", serverCommand("kernel_package", [])], { env: { PATH: path }, encoding: "utf8" }).stdout.trim();

  it("names the Ubuntu package for the running release with its full version, and drops the not-installed unsigned name", () => {
    const path = machine({
      "dpkg-query":
        "for p in \"$@\"; do case $p in -*) continue;; esac; [ \"$p\" = linux-image-6.8.0-139-generic ] && echo 'linux-image-6.8.0-139-generic 6.8.0-139.139' || echo \"$p \"; done",
    });
    expect(run(path)).toBe("linux-image-6.8.0-139-generic 6.8.0-139.139");
  });

  it("names the Red Hat kernel package with version and release", () => {
    const path = machine({
      uname: "echo 5.14.0-687.61.1.el9_8.x86_64",
      rpm: "for p in \"$@\"; do case $p in kernel-core-5.14.0-687.61.1.el9_8.x86_64) echo 'kernel-core 5.14.0-687.61.1.el9_8';; kernel-5*) echo \"package $p is not installed\";; esac; done",
    });
    expect(run(path)).toBe("kernel-core 5.14.0-687.61.1.el9_8");
  });

  it("says no package holds the kernel on a host whose kernel is not a package, instead of printing nothing", () => {
    expect(run(machine({ "dpkg-query": "exit 1" }))).toBe("no package holds the running kernel");
    expect(run(machine({}))).toBe("no package holds the running kernel");
  });
});

describe("the os_release fact on a Synology", () => {
  it("reads the DSM product version and build, since DSM has no /etc/os-release", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsm-"));
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    // Only /etc.defaults/VERSION exists; sw_vers is absent; `uname -a` would print the kernel line instead.
    stub("cat", "[ \"$1\" = /etc.defaults/VERSION ] && { printf 'productversion=\"7.1.1\"\\nbuildnumber=\"42962\"\\n'; exit 0; }; exit 1");
    stub("uname", "echo 'Linux gorillabank 4.4.180+ x86_64'");
    const ran = spawnSync("/bin/sh", ["-c", serverCommand("os_release", [])], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
    expect(ran.stdout).toContain("productversion=\"7.1.1\"");
    expect(ran.stdout).toContain("buildnumber=\"42962\"");
    expect(ran.stdout).not.toContain("4.4.180");
  });
});

describe("the sysctl fact", () => {
  const run = (path: string) =>
    spawnSync("/bin/sh", ["-c", serverCommand("sysctl", [])], { env: { PATH: path }, encoding: "utf8" });

  it("prints one key=value line per fixed key, and `unreadable` for a key the host lacks, never an error", () => {
    const ran = run("/usr/sbin:/sbin:/usr/bin:/bin");
    const lines = ran.stdout.trim().split("\n");
    expect(lines.map((line) => line.split("=")[0])).toEqual([...SYSCTL_KEYS]);
    for (const line of lines) expect(line).toMatch(/^[a-z_.]+=\S+$/);
    expect(ran.stderr).toBe("");
  });

  it("reports every key `unreadable`, and does not crash, when no tool can run", () => {
    // With no usable PATH neither `sysctl` nor `cat` runs, so each key must still print a well-formed line.
    const lines = run("/nonexistent").stdout.trim().split("\n");
    expect(lines).toHaveLength(SYSCTL_KEYS.length);
    for (const line of lines) expect(line).toMatch(/=unreadable$/);
  });

  /** A host whose `sysctl` refuses the login user, and a `sudo` that (when it works) reruns the command as root. */
  function hardenedHost(sudoBody: string) {
    const dir = mkdtempSync(join(tmpdir(), "hardened-"));
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    stub("sysctl", "[ \"$AS_ROOT\" = 1 ] && { echo 1; exit 0; }; echo \"sysctl: permission denied on key '$2'\" >&2; exit 255");
    stub("sudo", sudoBody);
    return `${dir}:/usr/bin:/bin`;
  }

  it("reads the setting with passwordless sudo when the login user is refused, as on zysys", () => {
    const path = hardenedHost("[ \"$1\" = -n ] || exit 1; shift; AS_ROOT=1 exec \"$@\"");
    const lines = run(path).stdout.trim().split("\n");
    expect(lines).toEqual(SYSCTL_KEYS.map((key) => `${key}=1`));
  });

  it("stays `unreadable`, and never prompts, when sudo would ask for a password", () => {
    // `-n` is what stops sudo prompting: a sudo that only fails under -n proves the flag is passed.
    const path = hardenedHost("[ \"$1\" = -n ] && { echo 'sudo: a password is required' >&2; exit 1; }; exit 0");
    const ran = run(path);
    expect(ran.stdout.trim().split("\n")).toEqual(SYSCTL_KEYS.map((key) => `${key}=unreadable`));
  });

  it("carries no value a model supplied: the keys are a constant list", () => {
    expect(serverCommand("sysctl", ["x; id"])).toBe(serverCommand("sysctl", []));
  });
});

describe("every fact's command parses and runs under the local /bin/sh", () => {
  // macOS's /bin/sh is bash 3.2, which cannot parse `case` inside `$( … )`; one parse error loses every fact after it.
  it("prints a begin and an end line for every server fact, with the package names asked", () => {
    const scripted = SERVER_FACTS.filter((fact) => fact !== "ssh_banner").map((fact) => ({
      fact,
      command_line: serverCommand(fact, ["nginx"]),
    }));
    const ran = spawnSync("/bin/sh", ["-c", factScript(scripted, NONCE)], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: 30_000,
    });
    expect(ran.stderr).not.toContain("syntax error");
    const sections = readSections(ran.stdout, NONCE);
    expect([...sections.keys()].sort()).toEqual(scripted.map((each) => each.fact).sort());
  });
});

describe("the script one SSH session runs", () => {
  it("reads each fact back by its own fenced section, so one fact's output cannot pass for another's", () => {
    const stdout = [
      sectionText(NONCE, "libc", { code: 0, output: "musl libc" }),
      `@@${NONCE}:begin:kernel\n@@${NONCE}:end:libc:0\n(a forged end line for a different fact is not an end)\n@@${NONCE}:end:kernel:0`,
      "@@other:begin:os_release\nforeign\n@@other:end:os_release:0",
    ].join("\n");
    const sections = readSections(stdout, NONCE);
    expect(sections.get("libc")).toEqual({ code: 0, output: "musl libc" });
    expect(sections.get("kernel")?.output).toContain("forged end line");
    expect(sections.has("os_release")).toBe(false);
  });

  it("drops a fact whose end line never came, so a cut-off session reads as not read", () => {
    expect(readSections(`@@${NONCE}:begin:libc\nmusl`, NONCE).size).toBe(0);
  });
});

describe("measureServer", () => {
  const asset = server("alpine", "192.0.2.10");
  const scripted = [
    { fact: "libc" as const, command_line: serverCommand("libc", []) },
    { fact: "sshd_links_pam" as const, command_line: serverCommand("sshd_links_pam", []) },
  ];

  it("reads the banner from the network and the rest in one SSH session, redacting nothing it should keep", async () => {
    const stdout = [
      sectionText(NONCE, "libc", { code: 0, output: "musl libc (x86_64)" }),
      sectionText(NONCE, "sshd_links_pam", { code: 0, output: "no PAM library linked" }),
    ].join("\n");
    const machine = new FakeMachine({ commands: { [sshCall("alpine", scripted)]: ok(stdout) } });
    const inventory = await measureServer(asset , ["libc", "sshd_links_pam", "ssh_banner"], [], machine, {
      net: net("SSH-2.0-OpenSSH_10.0"),
      nonce: () => NONCE,
      now: () => "T",
    });
    expect(inventory).toEqual({
      status: "measured",
      measured_at: "T",
      facts: [
        { fact: "libc", command_line: scripted[0]!.command_line, code: 0, output: "musl libc (x86_64)" },
        { fact: "sshd_links_pam", command_line: scripted[1]!.command_line, code: 0, output: "no PAM library linked" },
        { fact: "ssh_banner", command_line: "tcp connect 192.0.2.10:22, read the first line", code: 0, output: "SSH-2.0-OpenSSH_10.0" },
      ],
    });
    expect(machine.runs).toHaveLength(1);
  });

  it("is unmeasured, with the reason, when SSH will not connect and the banner is silent too", async () => {
    const machine = new FakeMachine({
      commands: { [sshCall("alpine", scripted)]: { code: 255, stdout: "", stderr: "alpine: Permission denied (publickey).\n" } },
    });
    const inventory = await measureServer(asset , ["libc", "sshd_links_pam", "ssh_banner"], [], machine, {
      net: net(new Error("ECONNREFUSED")),
      nonce: () => NONCE,
    });
    expect(inventory.status).toBe("unmeasured");
    expect(inventory).toMatchObject({ reason: expect.stringContaining("Permission denied (publickey)") });
  });

  it("keeps the banner when SSH fails: a partial reading is measured, and the missing fact says why", async () => {
    const machine = new FakeMachine({ commands: { [sshCall("alpine", scripted)]: { code: 255, stdout: "", stderr: "timed out" } } });
    const inventory = await measureServer(asset , ["libc", "sshd_links_pam", "ssh_banner"], [], machine, {
      net: net("SSH-2.0-OpenSSH_10.0"),
      nonce: () => NONCE,
    });
    expect(inventory.status).toBe("measured");
    if (inventory.status !== "measured") return;
    expect(inventory.facts.map((fact) => [fact.fact, fact.code])).toEqual([["libc", -1], ["sshd_links_pam", -1], ["ssh_banner", 0]]);
  });

  it("does not open an SSH session at all when WEBMASTER_SECURITY_SERVER=0", async () => {
    const machine = new FakeMachine({ environment: { WEBMASTER_SECURITY_SERVER: "0" } });
    const inventory = await measureServer(asset , ["libc"], [], machine, { nonce: () => NONCE });
    expect(machine.runs).toEqual([]);
    expect(inventory).toMatchObject({ status: "unmeasured", reason: expect.stringContaining("WEBMASTER_SECURITY_SERVER=0") });
  });

  it("never runs two SSH sessions to one target at once, but does run different targets together", async () => {
    let open = 0;
    let mostOpen = 0;
    const machine = new FakeMachine();
    machine.run = async () => {
      open++;
      mostOpen = Math.max(mostOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 10));
      open--;
      return { code: 255, stdout: "", stderr: "no" };
    };
    const same = [0, 1, 2].map(() => measureServer(asset , ["libc"], [], machine, { nonce: () => NONCE }));
    await Promise.all(same);
    expect(mostOpen).toBe(1);
    mostOpen = 0;
    await Promise.all(["a", "b"].map((name) => measureServer(server(name, name) , ["libc"], [], machine, { nonce: () => NONCE })));
    expect(mostOpen).toBe(2);
  });

  it("refuses to put a target that is not a plain word on an SSH command line", async () => {
    const machine = new FakeMachine();
    const inventory = await measureServer({ ...asset, target: "-oProxyCommand=id" } , ["libc"], [], machine, { nonce: () => NONCE });
    expect(machine.runs).toEqual([]);
    expect(inventory.status).toBe("unmeasured");
  });
});

describe("measureSite", () => {
  it("reads the web headers and generator without SSH", async () => {
    const machine = new FakeMachine();
    const inventory = await measureSite(SITE , ["web_headers"], machine, { net: net("-"), now: () => "T" });
    expect(inventory).toMatchObject({ status: "measured", facts: [{ fact: "web_headers", code: 0 }] });
    if (inventory.status !== "measured") return;
    expect(inventory.facts[0]!.output).toBe("status: 200\nserver: nginx/1.27.0\nx-powered-by: PHP/8.3\ngenerator meta: WordPress 6.8");
    expect(machine.runs).toEqual([]);
  });

  it("says why WordPress was not read when the site file has no host block", async () => {
    const inventory = await measureSite(SITE , ["wp_plugins"], new FakeMachine(), { net: net("-") });
    expect(inventory).toEqual({ status: "unmeasured", reason: "the site file names no host block, so WordPress cannot be read" });
  });
});

const SSH_CONFIG = `
Host *
  ServerAliveInterval 30
Host alpine alpine-lan
  HostName 192.0.2.10
  User ops
Host gateway
  HostName 192.0.2.20
Host *.internal !bad
  User x
`;

const SITES = "/home/zach/Developer/Zysys/webmaster/sites";
const siteFile = (name: string, target: string): string =>
  `url: https://www.${name}.test/\nplatform: wordpress\nhost:\n  transport: ssh\n  target: ${target}\n  wp_root: sites/${name}\n`;

describe("a site file's user@host and the SSH config's alias for that host", () => {
  it("are one server: the site links to the alias and no second server is listed", async () => {
    const machine = new FakeMachine({
      files: {
        "/home/zach/.ssh/config": "Host wpe.example.net\n  User other\n",
        [`${SITES}/linked.yaml`]: siteFile("linked", "linked@wpe.example.net"),
      },
      commands: {
        "ssh -G wpe.example.net": ok("user other\nhostname wpe.example.net\nport 22\n"),
        "ssh -G linked@wpe.example.net": ok("user linked\nhostname wpe.example.net\nport 22\n"),
      },
    });
    const servers = (await listAssets(machine)).filter((asset) => asset.kind === "server");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "wpe.example.net", sites: ["linked"], source: "ssh_config" });
  });

  it("share one SSH queue, since the host allows one session at a time", async () => {
    let open = 0;
    let mostOpen = 0;
    const machine = new FakeMachine();
    machine.run = async () => {
      open++;
      mostOpen = Math.max(mostOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 10));
      open--;
      return { code: 255, stdout: "", stderr: "no" };
    };
    const byAlias = measureServer(server("wpe.example.net", "wpe.example.net") , ["libc"], [], machine, { nonce: () => NONCE });
    const bySite = measureServer(server("linked@wpe.example.net", "wpe.example.net") , ["libc"], [], machine, { nonce: () => NONCE });
    await Promise.all([byAlias, bySite]);
    expect(mostOpen).toBe(1);
  });
});

describe("listing what the owner has access to", () => {
  it("takes concrete Host names only, and groups a machine's names", () => {
    expect(sshHostLines(SSH_CONFIG)).toEqual([["alpine", "alpine-lan"], ["gateway"]]);
  });

  it("never lists a Host name that would read as an ssh option", () => {
    expect(sshHostLines("Host -oProxyCommand=id good")).toEqual([["good"]]);
  });

  it("lists one server per machine, links each site to its server, and narrows by name", async () => {
    const resolved = (name: string, host: string) => ok(`user ops\nhostname ${host}\nport 22\n`);
    const machine = new FakeMachine({
      files: {
        "/home/zach/.ssh/config": SSH_CONFIG,
        [`${SITES}/example.yaml`]: siteFile("example", "gateway"),
        [`${SITES}/hosted.yaml`]: siteFile("hosted", "hosted@hosted.ssh.example.net"),
      },
      commands: {
        "ssh -G alpine": resolved("alpine", "192.0.2.10"),
        "ssh -G alpine-lan": resolved("alpine-lan", "192.0.2.10"),
        "ssh -G gateway": resolved("gateway", "192.0.2.20"),
        "ssh -G hosted@hosted.ssh.example.net": resolved("hosted", "hosted.ssh.example.net"),
      },
    });
    const assets = await listAssets(machine);
    const servers = assets.filter((asset) => asset.kind === "server");
    expect(servers.map((asset) => asset.name)).toEqual(["alpine", "gateway", "hosted@hosted.ssh.example.net"]);
    expect(servers[0]).toMatchObject({ aliases: ["alpine-lan"], hostname: "192.0.2.10", user: "ops", source: "ssh_config" });
    expect(servers[1]).toMatchObject({ sites: ["example"] });
    expect(servers[2]).toMatchObject({ sites: ["hosted"], source: "site_file" });
    expect(assets.filter((asset) => asset.kind === "site").map((asset) => asset.name)).toEqual(["example", "hosted"]);
    expect(narrowAssets(assets, { servers: ["alpine-lan"] }).map((asset) => asset.name)).toEqual(["alpine"]);
    expect(narrowAssets(assets, { sites: ["hosted"] }).map((asset) => asset.name)).toEqual(["hosted"]);
    expect(narrowAssets(assets, { servers: ["alpine"], sites: ["hosted"] }).map((asset) => asset.name)).toEqual(["alpine", "hosted"]);
    expect(narrowAssets(assets, {})).toEqual(assets);
  });
});

describe("the real runner", () => {
  it("passes the command to omp's exec with a timeout and records a stopped command as code -1", async () => {
    const calls: unknown[] = [];
    const pi = {
      cwd: "/tmp",
      exec: async (command: string, args: string[], options: unknown) => {
        calls.push([command, args, options]);
        return args[0] === "slow" ? { code: 0, stdout: "x", stderr: "e", killed: true } : { code: 3, stdout: "out", stderr: "err", killed: false };
      },
    };
    const run = runWithPi(pi as never);
    expect(await run("ssh", ["fast"])).toEqual({ code: 3, stdout: "out", stderr: "err" } satisfies ProcessResult);
    expect(await run("ssh", ["slow"])).toMatchObject({ code: -1, stdout: "x" });
    expect(calls[0]).toEqual(["ssh", ["fast"], { cwd: "/tmp", timeout: 300000 }]);
  });
});

describe("the tool", () => {
  const world = () =>
    new FakeMachine({
      files: {
        "/home/zach/.ssh/config": "Host alpine\n  HostName 192.0.2.10\n  User ops\n",
        [`${SITES}/example.yaml`]: siteFile("example", "alpine"),
      },
      commands: {
        "ssh -G alpine": ok("user ops\nhostname 192.0.2.10\nport 22\n"),
        [sshCall("alpine", [{ fact: "libc", command_line: serverCommand("libc", []) }])]: ok(
          sectionText(NONCE, "libc", { code: 0, output: "musl libc (x86_64)" }),
        ),
      },
    });

  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { machine: () => world() });
    expect(tool.name).toBe("webmaster_security_inventory");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ asset: "server:alpine" }).success).toBe(true);
    expect(schema.safeParse({ asset: "alpine", facts: null, package_names: null }).success).toBe(true);
    expect(schema.safeParse({ asset: "alpine", facts: ["libc"], package_names: ["openssh"] }).success).toBe(true);
    expect(schema.safeParse({ asset: 4 }).success).toBe(false);
    expect(schema.safeParse({ asset: "a", facts: "libc" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("finds the asset by label, bare name or alias, and says what is known when none matches", async () => {
    const machine = world();
    expect((await findAsset("server:alpine", machine)).name).toBe("alpine");
    expect((await findAsset("alpine", machine)).kind).toBe("server");
    expect((await findAsset("site:example", machine)).kind).toBe("site");
    expect((await findAsset("example", machine)).kind).toBe("site");
    await expect(findAsset("site:alpine", machine)).rejects.toThrow(/no server or site is named "alpine"; known: server:alpine, site:example/);
    await expect(findAsset("  ", machine)).rejects.toThrow(/needs a server or site name/);
  });

  it("reads the named facts of a server and returns { asset, inventory }", async () => {
    const machine = world();
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { machine: () => machine, nonce: () => NONCE, now: () => "T" });
    const result = await tool.execute("id", { asset: "server:alpine", facts: ["libc"], package_names: null }, undefined, undefined);
    expect(result.details).toEqual({
      asset: "server:alpine",
      inventory: { status: "measured", measured_at: "T", facts: [{ fact: "libc", command_line: serverCommand("libc", []), code: 0, output: "musl libc (x86_64)" }] },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    // `ssh -G` resolves names and connects to nothing; the one SSH session is the fact read.
    const lines = machine.runs.map((run) => run.commandLine);
    expect(lines.slice(0, -1).every((line) => line.startsWith("ssh -G "))).toBe(true);
    expect(lines.at(-1)).toStartWith(`ssh ${SSH_OPTIONS.join(" ")} -o ServerAliveInterval=15`);
  });

  it("refuses an unknown fact and a package name that could be shell syntax before running anything", async () => {
    const machine = world();
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { machine: () => machine });
    await expect(tool.execute("id", { asset: "alpine", facts: ["passwords"] }, undefined, undefined)).rejects.toThrow(/"passwords" is not a fact/);
    await expect(tool.execute("id", { asset: "alpine", package_names: ["x; id"] }, undefined, undefined)).rejects.toThrow(/is not a package name/);
    expect(machine.runs).toEqual([]);
  });

  it("builds the real machine from the runner and the environment: WEBMASTER_SECURITY_SERVER=0 runs no SSH session", async () => {
    const calls: string[] = [];
    const run = async (command: string, args: readonly string[]): Promise<ProcessResult> => {
      calls.push([command, ...args].join(" "));
      return command === "ssh" && args[0] === "-G" ? ok("user ops\nhostname 192.0.2.10\nport 22\n") : { code: 127, stdout: "", stderr: "unexpected" };
    };
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { run, environment: { WEBMASTER_SECURITY_SERVER: "0", WEBMASTER_SITES_DIR: "/nonexistent" }, nonce: () => NONCE });
    // No ~/.ssh/config server can be assumed on this machine, so name a site-less asset that cannot exist.
    await expect(tool.execute("id", { asset: "server:no-such-server-xyz" }, undefined, undefined)).rejects.toThrow(/no server or site is named/);
    expect(calls.every((call) => call.startsWith("ssh -G "))).toBe(true);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the gate and the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("WEBMASTER_SECURITY_SERVER=0");
    expect(DESCRIPTION).toContain("never says what they mean");
  });
});
