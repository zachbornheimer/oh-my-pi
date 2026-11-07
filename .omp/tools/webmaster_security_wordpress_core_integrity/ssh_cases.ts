import { afterAll, describe, expect, it } from "bun:test";
import type { InspectCommand } from "./inspect.ts";
import { heartbeat, type ServerDeps } from "./server_reading.ts";
import { depsFor, replay, siteDirectory, WRITE_WORDS } from "./ssh_support.ts";
import { loadZod } from "./zod_for_tests.ts";

/** What every server-reading check tool has to do the same way; each tool's own test adds its rule's cases. */

export interface CheckToolShape {
  name: string;
  description: string;
  loadMode: string;
  approval: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: never,
    onUpdate: unknown,
    ctx: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

export interface ServerSubject {
  name: string;
  check: string;
  description: string;
  makeTool: (pi: never, deps: ServerDeps) => CheckToolShape;
  /** The fixed commands the tool asks for against the compromised recording, in order. */
  commands: readonly InspectCommand[];
}

export const wordsOf = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const toolFor = async (subject: ServerSubject, deps: ServerDeps) =>
  subject.makeTool({ zod: await loadZod(), cwd: "." } as never, deps);

export const resultOf = async (tool: CheckToolShape, params: object, signal?: AbortSignal) =>
  (await tool.execute("call", params as never, undefined, undefined, signal)).details as {
    site: string;
    check: string;
    status: string;
    findings: { id: string; severity: string; evidence: string }[];
    reason?: string;
  };

export function serverToolCases(subject: ServerSubject): void {
  const sites = siteDirectory();
  const noHost = siteDirectory({ host: "" });
  const emptyDirectory = siteDirectory({ host: "" });
  afterAll(() => {
    sites.cleanup();
    noHost.cleanup();
    emptyDirectory.cleanup();
  });

  describe(`${subject.name}: the tool`, () => {
    it("loads against omp's own zod, takes a site, and refuses invalid input", async () => {
      const tool = await toolFor(subject, {});
      expect(tool.name).toBe(subject.name);
      const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
      expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
      expect(schema.safeParse({ site: "" }).success).toBe(false);
      expect(schema.safeParse({ site: 3 }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });

    it("is discoverable, needs exec approval (it runs ssh) and has a description in the house style", async () => {
      const tool = await toolFor(subject, {});
      expect(tool.loadMode).toBe("discoverable");
      expect(tool.approval).toBe("exec");
      expect(tool.description).toBe(subject.description);
      const words = wordsOf(tool.description);
      expect(words).toBeGreaterThanOrEqual(80);
      expect(words).toBeLessThanOrEqual(250);
      expect(tool.description).toContain('{"site":"example.org"');
      expect(tool.description).toContain("WEBMASTER_SECURITY_SERVER=1");
      expect(tool.description).toContain("unmeasured");
      expect(tool.description).toContain("webmaster_wordpress_inspect");
    });

    it("is unmeasured, and opens no connection, unless WEBMASTER_SECURITY_SERVER=1", async () => {
      const server = replay("compromised");
      const tool = await toolFor(subject, depsFor(server, sites.directory, {}));
      const result = await resultOf(tool, { site: "example.org" });
      expect(result).toMatchObject({ site: "example.org", check: subject.check, status: "unmeasured", findings: [] });
      expect(result.reason).toContain("WEBMASTER_SECURITY_SERVER=1");
      expect(server.runs).toEqual([]);
    });

    it("is unmeasured, and opens no connection, when the site has no site file or no host block", async () => {
      for (const directory of [emptyDirectory.directory, noHost.directory]) {
        const server = replay("compromised");
        const tool = await toolFor(subject, depsFor(server, directory));
        const result = await resultOf(tool, { site: "example.org" });
        expect(result.status).toBe("unmeasured");
        expect(result.reason).toContain("site file");
        expect(server.runs).toEqual([]);
      }
    });

    it("asks only its own fixed commands, each read-only and over SSH to the site file's host", async () => {
      const server = replay("compromised");
      const tool = await toolFor(subject, depsFor(server, sites.directory));
      await resultOf(tool, { site: "https://www.example.org/" });
      expect(server.asked).toEqual([...subject.commands]);
      for (const run of server.runs) {
        expect(run.command).toBe("ssh");
        expect(run.commandLine).toMatch(/^ssh -o BatchMode=yes -o ConnectTimeout=15 example-host /);
        const words = run.commandLine
          .replace(/^ssh .*? example-host /, "")
          .replace(/set -u; webmaster_wp\(\) \( .*? fi \)/s, "")
          .replace(/printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| /, "")
          .replace(/'[^']*'/g, "''");
        expect(words).not.toMatch(WRITE_WORDS);
      }
    });

    it("is unmeasured when SSH cannot connect, naming why", async () => {
      const first = subject.commands[0] as InspectCommand;
      const server = replay("compromised", {
        // The first command asked is the first one the tool runs: scans wait behind `content_directories`.
        [first]: { code: 255, stdout: "", stderr: "ssh: connect to host example-host port 22: Connection refused" },
      });
      const tool = await toolFor(subject, depsFor(server, sites.directory));
      const result = await resultOf(tool, { site: "example.org" });
      expect(result.status).toBe("unmeasured");
      expect(result.reason).toMatch(/^ssh example-host: ssh: connect to host/);
    });

    it("stops when cancelled, running nothing", async () => {
      const server = replay("compromised");
      const tool = await toolFor(subject, depsFor(server, sites.directory));
      const controller = new AbortController();
      controller.abort();
      await expect(resultOf(tool, { site: "example.org" }, controller.signal)).rejects.toThrow();
      expect(server.runs).toEqual([]);
    });

    it("refuses a site that is not a domain or address before reading anything", async () => {
      const server = replay("compromised");
      const tool = await toolFor(subject, depsFor(server, sites.directory));
      await expect(resultOf(tool, { site: "http://" })).rejects.toThrow(/not a domain or address/);
      expect(server.runs).toEqual([]);
    });

    it("sends progress while a read is running and stops sending once it ends", async () => {
      const updates: unknown[] = [];
      const stop = heartbeat((update: unknown) => updates.push(update), "reading", 5);
      await Bun.sleep(40);
      stop();
      const seen = updates.length;
      expect(seen).toBeGreaterThan(0);
      await Bun.sleep(30);
      expect(updates.length).toBe(seen);
    });
  });
}
