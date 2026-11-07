import { describe, expect, it } from "bun:test";
import { apiFixture, netFor, SITE } from "./http_support.ts";
import { httpToolCases, run } from "./http_cases.ts";
import { CHECK, xmlrpcVerdict } from "./rule.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: makeTool as never,
  requests: ["GET SITE/xmlrpc.php"],
  sibling: "webmaster_security_wordpress_rest_batch",
};
httpToolCases(subject);

describe("webmaster_security_wordpress_xmlrpc: the rule on recordings", () => {
  it("flags the live xmlrpc.php a compromised site answers, medium", async () => {
    const result = await run(subject, netFor(apiFixture("compromised")));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.xmlrpc", "medium"]]);
    expect(result.findings[0]?.evidence).toContain("/xmlrpc.php answered 405");
  });

  it("passes a clean site that refuses it", async () => {
    expect(await run(subject, netFor(apiFixture("clean")))).toMatchObject({ status: "pass", findings: [] });
  });

  it("flags a 2xx that carries a method response", async () => {
    const net = netFor(apiFixture("clean"), { [`${SITE}/xmlrpc.php`]: { status: 200, contentType: "text/xml", body: "<methodResponse><fault/></methodResponse>" } });
    const result = await run(subject, net);
    expect(result.findings[0]?.evidence).toContain("/xmlrpc.php answers XML-RPC");
  });

  it("leaves a 404, a plain 200 page and a 405 that is not WordPress' alone", async () => {
    for (const answer of [
      { status: 404, contentType: "text/html", body: "nope" },
      { status: 200, contentType: "text/html", body: "<html>home</html>" },
      { status: 405, contentType: "text/html", body: "Method not allowed" },
    ]) {
      expect((await run(subject, netFor(apiFixture("clean"), { [`${SITE}/xmlrpc.php`]: answer }))).status).toBe("pass");
    }
  });

  it("is unmeasured when the endpoint gave no answer, and when the public API was not read", async () => {
    const result = await run(subject, netFor(apiFixture("clean"), { [`${SITE}/xmlrpc.php`]: new Error("ETIMEDOUT") }));
    expect(result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(result.reason).toContain("ETIMEDOUT");
    expect(xmlrpcVerdict(undefined)).toEqual({ unmeasured: "the public API was not read" });
  });
});
