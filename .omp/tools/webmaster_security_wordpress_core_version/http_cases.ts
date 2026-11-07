import { describe, expect, it } from "bun:test";
import { FakeSecurityNet } from "./fake_net.ts";
import { apiFixture, netFor, SITE } from "./http_support.ts";
import { loadZod } from "./zod_for_tests.ts";

/** What every HTTP check tool has to do the same way; each tool's own test adds its rule's cases. */

export interface HttpToolShape {
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

export interface HttpSubject {
  name: string;
  check: string;
  description: string;
  makeTool: (pi: never, deps: { net?: FakeSecurityNet }) => HttpToolShape;
  /** The requests the tool sends against any site, as `METHOD address`, in the order the tool asks for them. */
  requests: readonly string[];
  /** The tool's sibling it names in its description. */
  sibling: string;
}

export const wordsOf = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const toolFor = async (subject: HttpSubject, net?: FakeSecurityNet) =>
  subject.makeTool({ zod: await loadZod(), cwd: "." } as never, net === undefined ? {} : { net });

export interface CheckDetails {
  site: string;
  check: string;
  status: string;
  findings: { id: string; severity: string; evidence: string }[];
  reason?: string;
}

export async function run(
  subject: HttpSubject,
  net: FakeSecurityNet,
  site = "example.org",
  signal?: AbortSignal,
): Promise<CheckDetails> {
  const tool = await toolFor(subject, net);
  return (await tool.execute("call", { site } as never, undefined, undefined, signal)).details as CheckDetails;
}

export function httpToolCases(subject: HttpSubject): void {
  describe(`${subject.name}: the tool`, () => {
    it("loads against omp's own zod, takes a site, and refuses invalid input", async () => {
      const tool = await toolFor(subject);
      expect(tool.name).toBe(subject.name);
      const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
      expect(schema.safeParse({ site: "example.org" }).success).toBe(true);
      expect(schema.safeParse({ site: "" }).success).toBe(false);
      expect(schema.safeParse({ site: 3 }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });

    it("is discoverable, read-only, and has a description in the house style", async () => {
      const tool = await toolFor(subject);
      expect(tool.loadMode).toBe("discoverable");
      expect(tool.approval).toBe("read");
      expect(tool.description).toBe(subject.description);
      const words = wordsOf(tool.description);
      expect(words).toBeGreaterThanOrEqual(80);
      expect(words).toBeLessThanOrEqual(250);
      expect(tool.description).toContain('{"site":"example.org"}');
      expect(tool.description).toContain("unmeasured");
      expect(tool.description).toContain("webmaster_wordpress_public_api");
      expect(tool.description).toContain(subject.sibling);
    });

    it("sends only the requests it reads: GETs, and for the batch route the one empty POST", async () => {
      const net = netFor(apiFixture("clean"));
      await run(subject, net, "https://example.org/some/page?x=1");
      expect(net.sent.map((request) => `${request.method} ${request.url}`).sort()).toEqual(
        subject.requests.map((request) => request.replace("SITE", SITE)).sort(),
      );
      for (const request of net.sent) {
        expect(["GET", "POST"]).toContain(request.method);
        if (request.method === "POST") expect(request.body).toBe('{"requests":[]}');
        else expect(request.body).toBeUndefined();
      }
    });

    it("answers for the apex domain, as the check it is", async () => {
      const result = await run(subject, netFor(apiFixture("clean")), "https://WWW.Example.org/");
      expect(result.site).toBe("example.org");
      expect(result.check).toBe(subject.check);
    });

    it("is unmeasured, never passing, when nothing answers", async () => {
      const dead = new Error("ENOTFOUND example.org");
      const world = Object.fromEntries(
        subject.requests.map((request) => [request.split(" ")[1]?.replace("SITE", SITE) as string, dead]),
      );
      const result = await run(subject, new FakeSecurityNet({ http: world }));
      expect(result.status).toBe("unmeasured");
      expect(result.findings).toEqual([]);
      expect(result.reason).toBeString();
    });

    it("refuses a site that is not a domain or address before sending anything", async () => {
      const net = netFor(apiFixture("clean"));
      await expect(run(subject, net, "http://")).rejects.toThrow(/not a domain or address/);
      expect(net.sent).toEqual([]);
    });

    it("stops when cancelled, sending nothing", async () => {
      const net = netFor(apiFixture("clean"));
      const controller = new AbortController();
      controller.abort();
      await expect(run(subject, net, "example.org", controller.signal)).rejects.toThrow();
      expect(net.sent).toEqual([]);
    });
  });
}
