import { afterAll, describe, expect, it } from "bun:test";
import { FakeSecurityNet } from "./fake_net.ts";
import { releaseBody } from "./http_support.ts";
import { RELEASES_URL } from "./public_api.ts";
import { autoUpdateHealthVerdict, CHECK, parseUpdateDiscovery } from "./rule.ts";
import { resultOf, serverToolCases, toolFor } from "./ssh_cases.ts";
import { depsFor, inspectFixture, inspectWith, replay, siteDirectory } from "./ssh_support.ts";
import { DESCRIPTION, makeTool, NAME } from "./tool.ts";

const RELEASES = ["7.1.4", "7.0.9", "6.9.5", "6.8.7"];
const releasesNet = (versions: readonly string[] | Error = RELEASES) =>
  new FakeSecurityNet({
    http: { [RELEASES_URL]: versions instanceof Error ? versions : { status: 200, contentType: "application/json", body: releaseBody(versions) } },
  });

// The shared SSH cases run against the real tool, with only the WordPress.org request recorded.
const subject = {
  name: NAME,
  check: CHECK,
  description: DESCRIPTION,
  makeTool: ((pi: never, deps: never) => makeTool(pi, { ...(deps as object), net: releasesNet() })) as never,
  commands: ["core_version", "update_discovery"] as const,
};
serverToolCases(subject);

const NOW = 1_793_113_200;
const HEALTHY = { timestamp: NOW + 7200, interval: 43_200 };
const NO_HOOKS = { pre_site_transient_update_core: [], pre_site_transient_update_plugins: [], auto_update_core: [], automatic_updater_disabled: [] };
const discovery = (changes: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hooks: NO_HOOKS, constants: { AUTOMATIC_UPDATER_DISABLED: null, WP_AUTO_UPDATE_CORE: null }, version_check: HEALTHY, now: NOW, ...changes })}\n`;
const hooked = (hooks: Record<string, unknown>) => discovery({ hooks: { ...NO_HOOKS, ...hooks } });
const DASH = { callback: "Dash_Widget_Manager::hide_core_update", file: "/var/www/x/cms/plugins/dash-widget-manager/includes/c.php" };

const sites = siteDirectory();
afterAll(sites.cleanup);
const check = async (version: string, update: string, net = releasesNet(), extra: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) => {
  const server = replay("clean", { core_version: { stdout: `${version}\n` }, update_discovery: { stdout: update }, ...extra });
  const tool = await toolFor({ ...subject, makeTool: ((pi: never, deps: never) => makeTool(pi, { ...(deps as object), net })) as never }, depsFor(server, sites.directory));
  return { result: await resultOf(tool, { site: "example.org" }), server, net };
};
const idsOf = (result: Awaited<ReturnType<typeof check>>["result"]) => result.findings.map((finding) => [finding.id, finding.severity]);

describe("webmaster_security_wordpress_auto_update_health: the rule", () => {
  it("passes a site on the newest release with nothing hooked and the cron on time", async () => {
    const { result } = await check("7.1.4", discovery());
    expect(result).toMatchObject({ site: "example.org", check: CHECK, status: "pass", findings: [] });
  });

  it("flags the recorded compromised server: core 6.4.3 on an unsupported branch, blinded by a plugin", async () => {
    const server = replay("compromised");
    const tool = await toolFor(subject, depsFor(server, sites.directory));
    const result = await resultOf(tool, { site: "example.org" });
    expect(result.status).toBe("fail");
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "security.wordpress.auto_update_health.core_unsupported_branch",
      "security.wordpress.auto_update_health.update_discovery_blinded",
    ]);
    expect(result.findings[1]?.evidence).toContain("plugin dash-widget-manager");
  });

  describe("the state the compromised production site was in: core 6.9.4 while 6.9.5 and 7.1.4 existed", () => {
    const blinded = hooked({ pre_site_transient_update_core: [DASH] });

    it("is a fail with two high findings, naming the plugin and the release it should be on", async () => {
      const { result } = await check("6.9.4", blinded);
      expect(idsOf(result)).toEqual([
        ["security.wordpress.auto_update_health.core_behind", "high"],
        ["security.wordpress.auto_update_health.update_discovery_blinded", "high"],
      ]);
      expect(result.findings[0]?.evidence).toMatch(/6\.9\.4.*6\.9\.5.*7\.1\.4/);
      expect(result.findings[1]?.evidence).toContain("`pre_site_transient_update_core` hooked by plugin dash-widget-manager");
    });

    it("is still high on the blinding alone once core is current", async () => {
      expect(idsOf((await check("7.1.4", blinded)).result)).toEqual([["security.wordpress.auto_update_health.update_discovery_blinded", "high"]]);
    });
  });

  it("never runs `wp core check-update`, which a filter can answer for", async () => {
    const { server } = await check("7.1.4", discovery());
    expect(server.runs.some((run) => run.commandLine.includes("check-update"))).toBe(false);
  });

  it("says nothing of a site that is on the newest branch but behind on core when the branch is current", async () => {
    expect((await check("7.1.3", discovery())).result.findings[0]?.id).toBe("security.wordpress.auto_update_health.core_behind");
    expect((await check("7.0.9", discovery())).result.status).toBe("pass");
  });

  it("flags a branch WordPress.org no longer releases, high", async () => {
    const { result } = await check("6.7.1", discovery());
    expect(idsOf(result)).toEqual([["security.wordpress.auto_update_health.core_unsupported_branch", "high"]]);
    expect(result.findings[0]?.evidence).toContain("7.1, 7.0, 6.9, 6.8");
  });

  it("flags a callback that can stop core updating, but not the stock `__return_*` that leaves them on", async () => {
    const stopper = { callback: "my_theme_stop_updates", file: "/var/www/x/wp-content/themes/mytheme/functions.php" };
    const { result } = await check("7.1.4", hooked({ automatic_updater_disabled: [stopper], auto_update_core: [{ callback: "__return_true", file: "/x/wp-includes/formatting.php" }] }));
    expect(idsOf(result)).toEqual([["security.wordpress.auto_update_health.auto_update_blocked", "high"]]);
    expect(result.findings[0]?.evidence).toContain("theme mytheme (my_theme_stop_updates)");
    const disabled = hooked({ auto_update_core: [{ callback: "__return_false", file: "/x/wp-includes/formatting.php" }] });
    expect((await check("7.1.4", disabled)).result.findings[0]?.evidence).toContain("a WordPress helper, `__return_false`");
  });

  it("flags the configuration constants that turn updates off, medium, and treats 0 and false as off-switches that are not set", async () => {
    const off = await check("7.1.4", discovery({ constants: { AUTOMATIC_UPDATER_DISABLED: true, WP_AUTO_UPDATE_CORE: false } }));
    expect(idsOf(off.result)).toEqual([["security.wordpress.auto_update_health.updater_disabled", "medium"]]);
    expect(off.result.findings[0]?.evidence).toContain("AUTOMATIC_UPDATER_DISABLED, WP_AUTO_UPDATE_CORE=false");
    for (const value of ["0", "false", false, null]) {
      expect((await check("7.1.4", discovery({ constants: { AUTOMATIC_UPDATER_DISABLED: value, WP_AUTO_UPDATE_CORE: true } }))).result.status).toBe("pass");
    }
  });

  it("flags a version check that is missing or more than two intervals late, medium", async () => {
    const missing = await check("7.1.4", discovery({ version_check: null }));
    expect(idsOf(missing.result)).toEqual([["security.wordpress.auto_update_health.version_check_cron", "medium"]]);
    expect(missing.result.findings[0]?.evidence).toContain("not scheduled");
    const late = await check("7.1.4", discovery({ version_check: { timestamp: NOW - 3 * 86_400, interval: 43_200 } }));
    expect(late.result.findings[0]?.evidence).toContain("72 hours late (its interval is 12 hours)");
    expect((await check("7.1.4", discovery({ version_check: { timestamp: NOW - 43_200, interval: 43_200 } }))).result.status).toBe("pass");
  });

  it("keeps a finding when another reading failed, naming nothing it could not read as a pass", async () => {
    const { result } = await check("7.1.4", discovery({ version_check: null }), releasesNet(new Error("ECONNRESET")));
    expect(result.status).toBe("fail");
    const bare = await check("7.1.4", discovery(), releasesNet(new Error("ECONNRESET")));
    expect(bare.result).toMatchObject({ status: "unmeasured", findings: [] });
    expect(bare.result.reason).toContain("ECONNRESET");
  });

  it("is unmeasured, never passing, when a command did not run or printed something unreadable", async () => {
    const noVersion = await check("7.1.4", discovery(), releasesNet(), { core_version: { code: 127, stdout: "", stderr: "wp: command not found" } });
    expect(noVersion.result.status).toBe("unmeasured");
    expect(noVersion.result.reason).toContain("did not run (exit 127)");
    const junk = await check("7.1.4", "PHP Fatal error: nope");
    expect(junk.result.status).toBe("unmeasured");
    expect(junk.result.reason).toContain("could not read the output");
    const noRelease = await check("not a version", discovery());
    expect(noRelease.result.status).toBe("unmeasured");
  });

  it("does not fetch the release list when the server was not read", async () => {
    const net = releasesNet();
    const server = replay("clean");
    const tool = await toolFor({ ...subject, makeTool: ((pi: never, deps: never) => makeTool(pi, { ...(deps as object), net })) as never }, depsFor(server, sites.directory, {}));
    expect((await resultOf(tool, { site: "example.org" })).status).toBe("unmeasured");
    expect(net.sent).toEqual([]);
  });

  it("asks WordPress.org once, with a GET, and never contacts the site", async () => {
    const { net } = await check("7.1.4", discovery());
    expect(net.sent).toEqual([{ method: "GET", url: RELEASES_URL }]);
  });
});

describe("parseUpdateDiscovery and the verdict on bare inputs", () => {
  it("reads the shape the command prints and refuses anything else", () => {
    expect(parseUpdateDiscovery(JSON.parse(discovery()))?.version_check).toEqual(HEALTHY);
    expect(parseUpdateDiscovery(JSON.parse(discovery({ version_check: null })))?.version_check).toBeNull();
    for (const broken of [null, [], { hooks: {} }, JSON.parse(discovery({ now: "x" })), JSON.parse(discovery({ hooks: { a: [{ callback: 1, file: "f" }] } })), JSON.parse(discovery({ version_check: { timestamp: "x", interval: 1 } }))]) {
      expect(parseUpdateDiscovery(broken)).toBeUndefined();
    }
  });

  it("is unmeasured when the inspection was not made, the commands were not run, or the releases were not read", () => {
    expect(autoUpdateHealthVerdict({ status: "unmeasured", reason: "server checks are off" }, undefined)).toEqual({ unmeasured: "server checks are off" });
    const inspect = inspectFixture("clean");
    expect(autoUpdateHealthVerdict({ ...inspect, outputs: [] }, { status: "measured", versions: RELEASES })).toMatchObject({ unmeasured: expect.stringContaining("did not run `core_version`") });
    expect(autoUpdateHealthVerdict(inspectWith(inspect, {}), undefined)).toEqual({ unmeasured: "the WordPress releases were not read" });
    expect(autoUpdateHealthVerdict(inspect, { status: "unmeasured", reason: "x" })).toEqual({ unmeasured: "x" });
  });
});
