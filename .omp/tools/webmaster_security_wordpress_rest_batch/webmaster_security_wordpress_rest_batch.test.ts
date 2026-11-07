import { describe, expect, it } from "bun:test";
import { apiFixture, netFor, SITE } from "./http_support.ts";
import { httpToolCases, run } from "./http_cases.ts";
import { CHECK, restBatchVerdict } from "./rule.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  requests: ["POST SITE/?rest_route=/batch/v1", "POST SITE/wp-json/batch/v1"],
  sibling: "webmaster_security_wordpress_user_enumeration",
};
httpToolCases(subject);

const batch = (status: number) => ({ status, contentType: "application/json", body: "{}" });

describe("webmaster_security_wordpress_rest_batch: the rule on recordings", () => {
  it("flags the batch routes a compromised site lets an anonymous visitor run, high", async () => {
    const result = await run(subject, netFor(apiFixture("compromised")));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.rest_batch", "high"]]);
    expect(result.findings[0]?.evidence).toContain("POST /?rest_route=/batch/v1 answered 207");
    expect(result.findings[0]?.evidence).toContain("POST /wp-json/batch/v1 answered 207");
  });

  it("passes a clean site that refuses anonymous batches", async () => {
    expect(await run(subject, netFor(apiFixture("clean")))).toMatchObject({ status: "pass", findings: [] });
  });

  it("flags a 200 from one route only, naming that route", async () => {
    const net = netFor(apiFixture("clean"), { [`${SITE}/wp-json/batch/v1`]: batch(200) });
    const result = await run(subject, net);
    expect(result.findings[0]?.evidence).toContain("POST /wp-json/batch/v1 answered 200");
    expect(result.findings[0]?.evidence).not.toContain("rest_route");
  });

  it("leaves 401, 403, 404 and 500 alone", async () => {
    for (const status of [401, 403, 404, 500]) {
      const net = netFor(apiFixture("clean"), { [`${SITE}/wp-json/batch/v1`]: batch(status), [`${SITE}/?rest_route=/batch/v1`]: batch(status) });
      expect((await run(subject, net)).status).toBe("pass");
    }
  });

  it("is judged by the route that answered when the other did not", async () => {
    const dead = netFor(apiFixture("clean"), { [`${SITE}/wp-json/batch/v1`]: new Error("ECONNRESET") });
    expect((await run(subject, dead)).status).toBe("pass");
    const open = netFor(apiFixture("clean"), { [`${SITE}/wp-json/batch/v1`]: new Error("ECONNRESET"), [`${SITE}/?rest_route=/batch/v1`]: batch(207) });
    expect((await run(subject, open)).status).toBe("fail");
  });

  it("is unmeasured when no route answered, and when the public API was not read", async () => {
    const dead = new Error("ETIMEDOUT");
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/wp-json/batch/v1`]: dead, [`${SITE}/?rest_route=/batch/v1`]: dead }));
    expect(result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(result.reason).toContain("ETIMEDOUT");
    expect(restBatchVerdict(undefined)).toEqual({ unmeasured: "the public API was not read" });
  });
});
