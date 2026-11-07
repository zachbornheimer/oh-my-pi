import { afterAll, describe, expect, it } from "bun:test";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, daysSince, newAdminsVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = { name: NAME, check: CHECK, description: DESCRIPTION, makeTool: makeTool as never, commands: ["administrators"] as const };
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: ReplayServer) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });
/** The recorded inspection was taken 2026-10-27T15:00:00Z, with 14 recent days. */
const admins = (...rows: [login: string, registered: string][]) =>
  JSON.stringify(rows.map(([user_login, user_registered], index) => ({ ID: index + 1, user_login, user_registered })));

describe("webmaster_security_wordpress_new_admins: the rule", () => {
  it("flags the administrator a compromised server gained, high, and leaves the old owner out", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.new_admins", "high"]]);
    expect(result.findings[0]?.evidence).toContain("wpsupport_hx (registered 2026-10-25 03:12:44)");
    expect(result.findings[0]?.evidence).not.toContain("siteowner");
    expect(result.findings[0]?.evidence).toContain("1 administrator account(s) were created in the last 14 days");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ status: "pass", findings: [] });
  });

  it("counts whole days: 13 days and 23 hours ago is recent, exactly 14 days ago is not", async () => {
    const recent = await check(replay("clean", { administrators: { stdout: admins(["late", "2026-10-13 15:00:01"]) } }));
    expect(recent.findings[0]?.evidence).toContain("late");
    const edge = await check(replay("clean", { administrators: { stdout: admins(["edge", "2026-10-13 15:00:00"]) } }));
    expect(edge.status).toBe("pass");
    expect(daysSince(new Date("2026-10-13T15:00:00Z"), new Date("2026-10-27T15:00:00Z"))).toBe(14);
  });

  it("ignores a registration date it cannot read instead of guessing", async () => {
    const result = await check(replay("clean", { administrators: { stdout: admins(["odd", "not a date"], ["none", ""]) } }));
    expect(result.status).toBe("pass");
  });

  it("is unmeasured, never passing, when the command did not run, failed or printed something unreadable", async () => {
    const missing = await check(replay("clean", { administrators: { code: 127, stdout: "", stderr: "wp: command not found" } }));
    expect(missing).toMatchObject({ status: "unmeasured", findings: [] });
    expect(missing.reason).toContain("did not run (exit 127)");
    expect((await check(replay("clean", { administrators: { code: 1, stdout: "", stderr: "Error: no WordPress" } }))).status).toBe(
      "unmeasured",
    );
    const garbled = await check(replay("clean", { administrators: { stdout: "Fatal error" } }));
    expect(garbled.status).toBe("unmeasured");
    expect(garbled.reason).toContain("could not read the output");
  });

  it("is unmeasured when the inspection was not made", () => {
    expect(newAdminsVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    const inspect = inspectFixture("clean");
    expect(newAdminsVerdict({ ...inspect, outputs: [] })).toEqual({ unmeasured: "the inspection did not run `administrators`" });
  });
});
