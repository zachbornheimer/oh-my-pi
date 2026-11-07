import { afterAll, describe, expect, it } from "bun:test";
import type { ReplayServer } from "./replay_server.ts";
import type { ReplayServer } from "./replay_server.ts";
import { CHECK, cronVerdict } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, inspectWith, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const subject = { name: NAME, check: CHECK, description: DESCRIPTION, makeTool: makeTool as never, commands: ["cron_events"] as const };
serverToolCases(subject);

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (server: ReturnType<typeof replay>) =>
  resultOf(await toolFor(subject, depsFor(server, sites.directory)), { site: "example.org" });
const events = (...hooks: string[]) => JSON.stringify(hooks.map((hook) => ({ hook, next_run_relative: "now", recurrence: "1 hour" })));

describe("webmaster_security_wordpress_cron: the rule", () => {
  it("flags the generated-looking hook a compromised server schedules, medium", async () => {
    const result = await check(replay("compromised"));
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => [finding.id, finding.severity])).toEqual([["security.wordpress.cron", "medium"]]);
    expect(result.findings[0]?.evidence).toContain("a8f3c19e7b2d4f60");
    expect(result.findings[0]?.evidence).not.toContain("wp_update_plugins");
  });

  it("passes a clean server", async () => {
    expect(await check(replay("clean"))).toMatchObject({ site: "example.org", check: CHECK, status: "pass", findings: [] });
  });

  it("flags 12+ hex digits, 24+ letters and digits, and names such as eval, base64, shell, exec, cmd, backdoor", async () => {
    const hooks = ["0123456789ab", "abcdefghijklmnopqrstuvwx", "run_eval_now", "x_BASE64_y", "wp_shell", "do_exec", "cmd_run", "my_backdoor"];
    const result = await check(replay("clean", { cron_events: { stdout: events(...hooks) } }));
    expect(result.status).toBe("fail");
    for (const hook of hooks) expect(result.findings[0]?.evidence).toContain(hook);
  });

  it("leaves ordinary hooks, and a short hex or underscore name, alone", async () => {
    const quiet = events("wp_version_check", "action_scheduler_run_queue", "abcdef01", "woocommerce_cleanup_sessions");
    expect(await check(replay("clean", { cron_events: { stdout: quiet } }))).toMatchObject({ status: "pass" });
  });

  it("names each hook once and says how many more there are past ten", async () => {
    const many = Array.from({ length: 12 }, (_, index) => `backdoor_${index}`);
    const result = await check(replay("clean", { cron_events: { stdout: events(...many, "backdoor_0") } }));
    expect(result.findings[0]?.evidence).toContain("and 2 more");
    expect(result.findings[0]?.evidence.match(/backdoor_0/g)).toHaveLength(1);
  });

  it("is unmeasured, never passing, when the command did not run or printed something unreadable", async () => {
    const missing = await check(replay("clean", { cron_events: { code: 127, stdout: "", stderr: "wp: command not found" } }));
    expect(missing).toMatchObject({ status: "unmeasured", findings: [] });
    expect(missing.reason).toContain("did not run (exit 127)");
    const garbled = await check(replay("clean", { cron_events: { stdout: "PHP Fatal error: Uncaught Error" } }));
    expect(garbled.status).toBe("unmeasured");
    expect(garbled.reason).toContain("could not read the output");
    const failed = await check(replay("clean", { cron_events: { code: 1, stdout: "[]", stderr: "Error: not a WordPress install" } }));
    expect(failed.status).toBe("unmeasured");
  });

  it("is unmeasured when the inspection never ran the command or was not made", () => {
    const inspect = inspectFixture("clean");
    expect(cronVerdict({ ...inspect, outputs: inspect.outputs.filter((output) => output.command !== "cron_events") })).toEqual({
      unmeasured: "the inspection did not run `cron_events`",
    });
    expect(cronVerdict({ status: "unmeasured", reason: "server checks are off" })).toEqual({ unmeasured: "server checks are off" });
    expect(cronVerdict(undefined)).toEqual({ unmeasured: "the server was not inspected" });
    expect(cronVerdict(inspectWith(inspect, {}))).toEqual([]);
  });
});
