import { describe, expect, it } from "bun:test";
import { apiFixture, netFor, SITE } from "./http_support.ts";
import { httpToolCases, run } from "./http_cases.ts";
import { CHECK, userEnumerationVerdict } from "./rule.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  requests: ["GET SITE/wp-json/wp/v2/users", "GET SITE/?rest_route=/wp/v2/users", "GET SITE/?author=1"],
  sibling: "webmaster_security_wordpress_new_admins",
};
httpToolCases(subject);

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

describe("webmaster_security_wordpress_user_enumeration: the rule on recordings", () => {
  it("flags the user names a compromised site hands out, medium, naming both ways in", async () => {
    const result = await run(subject, netFor(apiFixture("compromised")));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.user_enumeration", "medium"]]);
    const evidence = result.findings[0]?.evidence ?? "";
    expect(evidence).toContain("admin, zach");
    expect(evidence).toContain("/wp-json/wp/v2/users lists them");
    expect(evidence).toContain("/?author=1 redirects to /author/admin/");
  });

  it("passes a clean site", async () => {
    expect(await run(subject, netFor(apiFixture("clean")))).toMatchObject({ status: "pass", findings: [] });
  });

  it("flags an author redirect alone, taking the name from it", async () => {
    const net = netFor(apiFixture("clean"), { [`${SITE}/?author=1`]: { status: 301, contentType: "", body: "", location: `${SITE}/author/editor/` } });
    const result = await run(subject, net);
    expect(result.findings[0]?.evidence).toContain("User names are public: editor.");
  });

  it("leaves a redirect to somewhere that is not an author page, and a 4xx with a location, alone", async () => {
    for (const answer of [
      { status: 301, contentType: "", body: "", location: `${SITE}/` },
      { status: 404, contentType: "", body: "", location: `${SITE}/author/editor/` },
    ]) {
      expect((await run(subject, netFor(apiFixture("clean"), { [`${SITE}/?author=1`]: answer }))).status).toBe("pass");
    }
  });

  it("flags a users listing alone, and ignores one that has no slugs or is not JSON", async () => {
    const listing = netFor(apiFixture("clean"), { [`${SITE}/?rest_route=/wp/v2/users`]: json([{ id: 3, slug: "editor" }]) });
    const found = await run(subject, listing);
    expect(found.findings[0]?.evidence).toContain("User names are public: editor.");
    expect(found.findings[0]?.evidence).toContain("/?rest_route=/wp/v2/users lists them");
    for (const body of [json([{ id: 1 }]), json({ users: [] }), { status: 200, contentType: "text/html", body: "<html>" }]) {
      expect((await run(subject, netFor(apiFixture("clean"), { [`${SITE}/wp-json/wp/v2/users`]: body }))).status).toBe("pass");
    }
  });

  it("names at most five users and says how many more there are", async () => {
    const users = Array.from({ length: 8 }, (_, index) => ({ id: index, slug: `user${index}` }));
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/wp-json/wp/v2/users`]: json(users) }));
    expect(result.findings[0]?.evidence).toContain("user0, user1, user2, user3, user4, and 3 more");
  });

  it("is unmeasured when nothing answered, and when the public API was not read", async () => {
    const dead = new Error("ETIMEDOUT");
    const net = netFor(apiFixture("clean"), {
      [`${SITE}/wp-json/wp/v2/users`]: dead,
      [`${SITE}/?rest_route=/wp/v2/users`]: dead,
      [`${SITE}/?author=1`]: dead,
    });
    const result = await run(subject, net);
    expect(result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(result.reason).toContain("ETIMEDOUT");
    expect(userEnumerationVerdict({})).toEqual({ unmeasured: "the public API was not read" });
  });
});
