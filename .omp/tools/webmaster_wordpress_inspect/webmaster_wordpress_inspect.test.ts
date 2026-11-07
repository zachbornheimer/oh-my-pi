import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT, FakeWordpressServer, zycmsLayout } from "./fake_server.ts";
import {
  contentDirectories,
  INSPECT_COMMANDS,
  inspectCommands,
  measureWordpressInspect,
  type ProcessResult,
  type RunProcess,
  SERVER_OFF_REASON,
} from "./inspect.ts";
import { DESCRIPTION, makeTool, runWithPi } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

const NOW = () => "2026-10-27T15:00:00.000Z";
const SERVER = {
  transport: "ssh",
  target: "example-host",
  wp_root: "/var/www/example/httpdocs",
  wp_cli: "sudo -n -u example -- /usr/local/bin/wp",
  file_prefix: "sudo -n -u example --",
};
/** Words that, in a command sent to a production server, could change it. */
const WRITE_WORDS =
  /(^|\s)(rm|mv|cp|chmod|chown|tee|dd|truncate|sed\s+-i|update|install|activate|deactivate|delete|create|set|-delete|-exec)(\s|$)|>/;
/** Calls that, in a program run on a production server, could change it or run something else. */
const WRITE_CALLS =
  /\b(add_option|update_option|delete_option|set_transient|delete_transient|wp_schedule_\w+|wp_unschedule_\w+|wp_clear_scheduled_hook|file_put_contents|fwrite|unlink|rename|mkdir|rmdir|copy|touch|chmod|exec|system|passthru|shell_exec|proc_open|popen|eval|include|require|add_filter|add_action|remove_filter|remove_action)\b|\$wpdb/;

const never: RunProcess = async () => {
  throw new Error("nothing may run");
};

describe("the WordPress inspection", () => {
  it("runs exactly the fixed read-only commands, each over SSH to the site file's host", async () => {
    const server = new FakeWordpressServer(zycmsLayout());
    await measureWordpressInspect(SERVER, server.run, { now: NOW });
    expect(server.runs).toHaveLength(INSPECT_COMMANDS.length);
    for (const run of server.runs) {
      expect(run.command).toBe("ssh");
      expect(run.commandLine).toMatch(/^ssh -o BatchMode=yes -o ConnectTimeout=15 example-host /);
      // The fixed `cd`-or-`--path` function, a PHP program (judged below, by what it calls) and quoted words are set aside.
      const words = run.commandLine
        .replace(/^ssh .*? example-host /, "")
        .replace(/set -u; webmaster_wp\(\) \( .*? fi \)/s, "")
        .replace(/printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| /, "")
        .replace(/'[^']*'/g, "''");
      expect(words).not.toMatch(WRITE_WORDS);
    }
  });

  it("records every command's output, unread, in order", async () => {
    const inspect = await measureWordpressInspect(SERVER, new FakeWordpressServer(zycmsLayout()).run, { now: NOW });
    if (inspect.status !== "measured") throw new Error("expected a measurement");
    expect(inspect.outputs.map((output) => output.command)).toEqual([...INSPECT_COMMANDS]);
    expect(inspect).toMatchObject({ measured_at: "2026-10-27T15:00:00.000Z", recent_days: 14 });
    expect(inspect.outputs.find((output) => output.command === "core_version")?.stdout).toBe("6.7.1\n");
  });

  it("lists plugins and themes with the site's plugins loaded, so premium updaters report", async () => {
    const server = new FakeWordpressServer(zycmsLayout());
    await measureWordpressInspect(SERVER, server.run, { now: NOW });
    const fields = "'--fields=name,title,status,version,update,update_version,auto_update'";
    const remotes = server.runs.map((run) => run.commandLine.replace(/^ssh .*? example-host /, ""));
    expect(remotes.some((remote) => remote.endsWith(`; webmaster_wp plugin list --format=json ${fields}`))).toBe(true);
    expect(remotes.some((remote) => remote.endsWith(`; webmaster_wp theme list --format=json ${fields}`))).toBe(true);
  });

  it("scans the folders WordPress names, never an assumed wp-content", async () => {
    const server = new FakeWordpressServer(zycmsLayout());
    await measureWordpressInspect(SERVER, server.run, { now: NOW });
    const scans = server.runs.map((run) => run.commandLine).filter((line) => / find /.test(line));
    expect(scans.map((line) => /find -H (\S+)/.exec(line)?.[1])).toEqual([`${CONTENT}/uploads`, `${CONTENT}/plugins`, `${CONTENT}/themes`]);
    expect(server.runs.filter((run) => run.commandLine.includes("wp-content"))).toEqual([]);
  });

  it("runs no scan, and says why, when WordPress will not name its folders", async () => {
    const server = new FakeWordpressServer(zycmsLayout({ contentDirectories: "unresolvable" }));
    const inspect = await measureWordpressInspect(SERVER, server.run, { now: NOW });
    if (inspect.status !== "measured") throw new Error("expected a measurement");
    expect(inspect.outputs.map((output) => output.command)).toEqual(
      INSPECT_COMMANDS.filter((command) => !["uploads_php", "plugin_directories", "theme_directories"].includes(command)),
    );
    expect(server.runs.filter((run) => / find /.test(run.commandLine))).toEqual([]);
    const resolved = inspect.outputs.find((output) => output.command === "content_directories")!;
    expect(contentDirectories(resolved)).toMatchObject({ unmeasured: expect.stringMatching(/could not resolve the content folders/) });
  });

  it("sends programs that read hooks and folders and call nothing that writes", async () => {
    const server = new FakeWordpressServer(zycmsLayout());
    await measureWordpressInspect(SERVER, server.run, { now: NOW });
    const programs = server.runs.flatMap((run) =>
      [...run.commandLine.matchAll(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => Buffer.from(m[1]!, "base64").toString()),
    );
    expect(programs).toHaveLength(2);
    for (const program of programs) expect(program).not.toMatch(WRITE_CALLS);
    expect(programs.find((program) => program.includes("wp_upload_dir"))).toContain("wp_upload_dir(null, false)");
  });

  it("refuses a site whose values could do more than read, before anything runs", async () => {
    expect(() => inspectCommands({ ...SERVER, wp_cli: "wp; rm -rf /" })).toThrow(/wp_cli/);
    expect(await measureWordpressInspect({ ...SERVER, wp_root: "/var/www/$(id)" }, never)).toMatchObject({
      status: "unmeasured",
      reason: expect.stringMatching(/wp_root/),
    });
    expect(await measureWordpressInspect({ ...SERVER, target: "host;reboot" }, never)).toMatchObject({
      status: "unmeasured",
      reason: expect.stringMatching(/target/),
    });
  });

  it("is unmeasured with why for no host, a host with no SSH, and a session that does not open", async () => {
    expect(await measureWordpressInspect(undefined, never)).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/no host block/) });
    expect(await measureWordpressInspect({ ...SERVER, transport: "ecs" }, never)).toMatchObject({
      status: "unmeasured",
      reason: expect.stringMatching(/reached by ecs, not SSH/),
    });
    const refused: RunProcess = async () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey).\n" });
    expect(await measureWordpressInspect(SERVER, refused)).toEqual({
      status: "unmeasured",
      reason: "ssh example-host: Permission denied (publickey).",
    });
  });

  it("records a command that fails, and keeps going", async () => {
    const run: RunProcess = async (_command, args) =>
      args.at(-1)!.endsWith("core version")
        ? { code: 127, stdout: "", stderr: "wp: command not found" }
        : { code: 0, stdout: "[]", stderr: "" };
    const inspect = await measureWordpressInspect(SERVER, run, { now: NOW });
    if (inspect.status !== "measured") throw new Error("expected a measurement");
    expect(inspect.outputs.find((output) => output.command === "core_version")).toMatchObject({ code: 127, stderr: "wp: command not found" });
    expect(inspect.outputs.length).toBeGreaterThan(8);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(measureWordpressInspect(SERVER, never, { signal: controller.signal })).rejects.toThrow();
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
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wm-sites-"));
    writeFileSync(
      join(directory, "example.yaml"),
      "name: example\nurl: https://www.example.org\nhost:\n  transport: ssh\n  target: example-host\n  wp_root: /var/www/example/httpdocs\n",
    );
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { run: never, environment: {} });
    expect(tool.name).toBe("webmaster_wordpress_inspect");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", server: null }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", server: { transport: "ssh", target: "h", wp_root: "/w", wp_cli: null } }).success).toBe(true);
    expect(schema.safeParse({ site: "example.org", server: { transport: "ssh" } }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("makes no connection and says why when server checks are off", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { run: never, sitesDirectory: directory, environment: {} });
    const result = await tool.execute("id", { site: "example.org" }, undefined, undefined);
    expect(result.details).toEqual({ site: "example.org", inspect: { status: "unmeasured", reason: SERVER_OFF_REASON } });
    const off = makeTool({ zod: await loadZod(), cwd: "." } as never, { run: never, sitesDirectory: directory, environment: { WEBMASTER_SECURITY_SERVER: "0" } });
    expect((await off.execute("id", { site: "example.org" }, undefined, undefined)).details.inspect.status).toBe("unmeasured");
  });

  it("with the switch on, reads the host from the site file, and from the input when given", async () => {
    const zod = await loadZod();
    const fromFile = new FakeWordpressServer(zycmsLayout());
    const tool = makeTool({ zod, cwd: "." } as never, {
      run: fromFile.run,
      sitesDirectory: directory,
      environment: { WEBMASTER_SECURITY_SERVER: "1" },
      now: NOW,
    });
    const result = await tool.execute("id", { site: "https://www.example.org/x" }, undefined, undefined);
    expect(result.details.site).toBe("example.org");
    expect(result.details.inspect).toMatchObject({ status: "measured", measured_at: "2026-10-27T15:00:00.000Z" });
    expect(fromFile.runs.every((run) => /^ssh -o BatchMode=yes -o ConnectTimeout=15 example-host /.test(run.commandLine))).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
    const given = new FakeWordpressServer(zycmsLayout());
    const withServer = makeTool({ zod, cwd: "." } as never, {
      run: given.run,
      sitesDirectory: join(tmpdir(), "no-such-sites-dir"),
      environment: { WEBMASTER_SECURITY_SERVER: "1" },
    });
    await withServer.execute("id", { site: "example.net", server: { transport: "ssh", target: "other-host", wp_root: "/srv/wp" } }, undefined, undefined);
    expect(given.runs[0]!.commandLine).toMatch(/^ssh -o BatchMode=yes -o ConnectTimeout=15 other-host /);
  });

  it("is unmeasured, never an error, when no host is known; refuses a site that is not a host", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      run: never,
      sitesDirectory: join(tmpdir(), "no-such-sites-dir"),
      environment: { WEBMASTER_SECURITY_SERVER: "1" },
    });
    const result = await tool.execute("id", { site: "example.net" }, undefined, undefined);
    expect(result.details.inspect).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/no host block/) });
    await expect(tool.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(/not a domain or address/);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the gate and the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("WEBMASTER_SECURITY_SERVER=1");
    expect(DESCRIPTION).toContain("never judges");
  });
});
