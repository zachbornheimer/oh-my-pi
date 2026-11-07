import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSecurityNet } from "./fake_net.ts";
import { type InspectRow, type InventoryEvidence, type InventoryOutput, NO_INSPECTION_REASON, parseReply, runInventory } from "./inventory.ts";
import { type ProcessResult, type RunProcess, SERVER_OFF_REASON } from "./inspect.ts";
import { askJson, type ModelStep, MODEL_ATTEMPTS } from "./omp_model.ts";
import { promptFor, replySchema } from "./question.ts";
import { RELEASES_URL } from "./releases.ts";
import { DESCRIPTION, INVENTORY_COMMANDS, makeTool } from "./tool.ts";
import { loadZod } from "./zod_for_tests.ts";

const plugins = [
  { name: "akismet", title: "Akismet Anti-spam", status: "active", version: "5.3", update: "none", update_version: "", auto_update: "off" },
  { name: "woocommerce-subscriptions", title: "WooCommerce Subscriptions", status: "active", version: "8.3.1", update: "available", update_version: "9.3.0", auto_update: "off" },
  { name: "isjac-glue.php", title: "", status: "must-use", version: "", update: "none", update_version: "", auto_update: "off" },
  { name: "advanced-cache.php", title: "", status: "dropin", version: "", update: "none", update_version: "", auto_update: "off" },
  { name: "mystery-tool", title: "Mystery Tool", status: "inactive", version: "", update: "unavailable", update_version: "", auto_update: "off" },
];
const themes = [
  { name: "twentytwentyfive", title: "Twenty Twenty-Five", status: "active", version: "1.2", update: "none", update_version: "", auto_update: "off" },
];

const row = (command: string, stdout: string, code = 0): InspectRow => ({ command, command_line: `wp ${command}`, code, stdout, stderr: "" });

/** Shaped like isjac.org's result: core current on the newest 6.7 release, one outdated premium plugin, MU plugins. */
const inspect = (overrides: Record<string, string> = {}): InventoryEvidence["inspect"] => ({
  status: "measured",
  outputs: [
    row("core_version", overrides["core_version"] ?? "6.7.1\n"),
    row("plugin_list", overrides["plugin_list"] ?? JSON.stringify(plugins)),
    row("theme_list", overrides["theme_list"] ?? JSON.stringify(themes)),
  ],
});
const releases = (versions: string[]): InventoryEvidence["public_api"] => ({ status: "measured", releases: { status: "measured", versions } });

const note = (slug: string, name: string, official_url: string | null, suspicious: string[] = []) => ({ slug, name, official_url, suspicious });

/** What a well-behaved model says; `meddle` adds the versions it must not be able to change. */
const reply = (meddle = false) => ({
  Inventory: {
    core: note("wordpress", "WordPress", "https://wordpress.org/download/"),
    plugins: [
      note("akismet", "Akismet Anti-spam", "https://wordpress.org/plugins/akismet/"),
      {
        ...note("woocommerce-subscriptions", "WooCommerce Subscriptions", "https://woocommerce.com/products/woocommerce-subscriptions/"),
        ...(meddle ? { installed_version: "9.3.0", latest_version: "9.3.0", up_to_date: "yes" } : {}),
      },
      note("isjac-glue.php", "isjac glue", null, ["isjac-glue.php is a must-use plugin of unknown origin."]),
      note("advanced-cache.php", "Advanced cache drop-in", null),
      note("mystery-tool", "Mystery Tool", null, ["mystery-tool has no known official source."]),
    ],
    themes: [note("twentytwentyfive", "Twenty Twenty-Five", "https://wordpress.org/themes/twentytwentyfive/")],
  },
});

/** A model step that answers each call from `answers` (an `Error` is a failed call) and records the prompts. */
function model(answers: (unknown | Error)[]): ModelStep & { prompts: string[] } {
  const prompts: string[] = [];
  const step = (async (prompt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    prompts.push(prompt);
    const answer = answers[Math.min(prompts.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  }) as ModelStep & { prompts: string[] };
  step.prompts = prompts;
  return step;
}

/** Runs the inventory with a model step and the real `askJson` retry, as the tool does. */
function inventoryRun(input: InventoryEvidence, step: ModelStep): Promise<InventoryOutput> {
  return runInventory(input, { prompt: promptFor, judge: ({ prompt, accept }) => askJson(step, prompt, accept) });
}

const SITE: InventoryEvidence = { site: "isjac.org", inspect: inspect(), public_api: releases(["6.7.1", "6.4.5"]) };
const measured = (result: InventoryOutput) => {
  if (result.inventory.status !== "measured") throw new Error(`expected measured, got ${result.inventory.reason}`);
  return result.inventory;
};

describe("the WordPress inventory", () => {
  it("reports the outdated premium plugin with both versions and its vendor URL, core current", async () => {
    const step = model([reply()]);
    const inventory = measured(await inventoryRun(SITE, step));
    expect(inventory.core).toMatchObject({ installed_version: "6.7.1", latest_version: "6.7.1", up_to_date: "yes", official_url: "https://wordpress.org/download/" });
    const woo = inventory.plugins.find((plugin) => plugin.slug === "woocommerce-subscriptions")!;
    expect(woo).toMatchObject({ installed_version: "8.3.1", latest_version: "9.3.0", up_to_date: "no", official_url: "https://woocommerce.com/products/woocommerce-subscriptions/" });
    expect(inventory.plugins.find((plugin) => plugin.slug === "akismet")).toMatchObject({ up_to_date: "yes" });
    expect(inventory.themes).toHaveLength(1);
    expect(step.prompts).toHaveLength(1);
    expect(step.prompts[0]).toContain("woocommerce-subscriptions | WooCommerce Subscriptions | active | installed 8.3.1 | latest 9.3.0");
  });

  it("flags unversioned items, must-use plugins and drop-ins as suspicious with no update channel", async () => {
    const { plugins: listed } = measured(await inventoryRun(SITE, model([reply()])));
    const by = (slug: string) => listed.find((plugin) => plugin.slug === slug)!;
    for (const slug of ["isjac-glue.php", "advanced-cache.php"]) {
      expect(by(slug)).toMatchObject({ installed_version: null, latest_version: null, up_to_date: "unknown" });
      expect(by(slug).suspicious.join(" ")).toMatch(/no update channel/);
      expect(by(slug).suspicious.join(" ")).toMatch(/no version/);
      expect(by(slug).suspicious.join(" ")).toMatch(/no known official source/);
    }
    expect(by("mystery-tool").suspicious.join(" ")).toMatch(/update channel reports nothing/);
  });

  it("is unmeasured, asking no model, when the inspection is off, absent or its list unreadable", async () => {
    const silent = model([new Error("no model call expected")]);
    const off = { status: "unmeasured" as const, reason: "server checks are off; set WEBMASTER_SECURITY_SERVER=1" };
    expect((await inventoryRun({ site: "isjac.org", inspect: off }, silent)).inventory).toEqual(off);
    expect((await inventoryRun({ site: "isjac.org" }, silent)).inventory).toEqual({ status: "unmeasured", reason: NO_INSPECTION_REASON });
    expect((await inventoryRun({ site: "isjac.org", inspect: inspect({ plugin_list: "Error: not WordPress" }) }, silent)).inventory).toMatchObject({
      status: "unmeasured",
      reason: expect.stringContaining("Error: not WordPress"),
    });
    const didNotRun = { status: "measured" as const, outputs: [row("core_version", "", 0), { ...row("plugin_list", "", 255), stderr: "ssh: no route" }, row("theme_list", "[]")] };
    expect((await inventoryRun({ site: "isjac.org", inspect: didNotRun }, silent)).inventory).toMatchObject({ reason: expect.stringContaining("did not run (exit 255): ssh: no route") });
    expect(silent.prompts).toHaveLength(0);
  });

  it("the model cannot change a measured version or up-to-date answer", async () => {
    const woo = measured(await inventoryRun(SITE, model([reply(true)]))).plugins.find((plugin) => plugin.slug === "woocommerce-subscriptions")!;
    expect(woo).toMatchObject({ installed_version: "8.3.1", latest_version: "9.3.0", up_to_date: "no" });
    expect(Object.keys(parseReply(reply(true)).Inventory.plugins[1]!)).toEqual(["slug", "name", "official_url", "suspicious"]);
  });

  it("asks again, showing the reason, when the model leaves an item out or answers badly", async () => {
    const short = reply();
    short.Inventory.plugins = short.Inventory.plugins.slice(0, 2);
    const step = model([short, "not json at all", reply()]);
    const inventory = measured(await inventoryRun(SITE, step));
    expect(step.prompts).toHaveLength(3);
    expect(step.prompts[1]).toContain("the reply leaves out: isjac-glue.php, advanced-cache.php, mystery-tool");
    expect(step.prompts[2]).toContain("the reply is not JSON");
    expect(inventory.plugins).toHaveLength(5);
  });

  it("keeps the measured versions and says so when the model cannot answer", async () => {
    const inventory = measured(await inventoryRun(SITE, model([new Error("model unavailable")])));
    expect(inventory.judgment_unavailable).toMatch(/missing: model unavailable/);
    expect(inventory.plugins.find((plugin) => plugin.slug === "woocommerce-subscriptions")).toMatchObject({ installed_version: "8.3.1", latest_version: "9.3.0", official_url: null });
    expect(measured(await inventoryRun(SITE, model(["x", "x", "x", "x"]))).judgment_unavailable).toMatch(new RegExp(`no valid reply after ${MODEL_ATTEMPTS} attempts`));
  });

  it("does not turn a cancelled run into a model failure", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runInventory(SITE, { prompt: promptFor, judge: ({ prompt, accept }) => askJson(model([reply()]), prompt, accept, { signal: controller.signal }) }),
    ).rejects.toThrow();
  });

  it("reports core behind its branch or on a retired branch from the WordPress.org releases", async () => {
    const behind = measured(await inventoryRun({ ...SITE, inspect: inspect({ core_version: "6.7.0\n" }) }, model([reply()])));
    expect(behind.core).toMatchObject({ installed_version: "6.7.0", latest_version: "6.7.1", up_to_date: "no" });
    const retired = measured(await inventoryRun({ ...SITE, inspect: inspect({ core_version: "5.9.3\n" }) }, model([reply()]))).core;
    expect(retired).toMatchObject({ up_to_date: "no", latest_version: "6.7.1" });
    expect(retired.suspicious.join(" ")).toMatch(/no longer releases/);
    const unknown = measured(await inventoryRun({ ...SITE, public_api: undefined }, model([reply()]))).core;
    expect(unknown).toMatchObject({ installed_version: "6.7.1", latest_version: null, up_to_date: "unknown" });
    const unreadable = measured(await inventoryRun({ ...SITE, inspect: inspect({ core_version: "Error: nope\n" }) }, model([reply()]))).core;
    expect(unreadable.installed_version).toBeNull();
    expect(unreadable.suspicious[0]).toMatch(/core reports no readable version/);
  });
});

describe("the question", () => {
  it("renders the evidence, the example and the reply schema into one prompt", () => {
    const prompt = promptFor("Site: example.org\n\n## Core\n- wordpress | WordPress | installed 6.9.1 | latest 6.9.1");
    expect(prompt).toContain("Site: example.org");
    expect(prompt).not.toContain("{evidence}");
    expect(prompt).toContain("Example answer:");
    expect(prompt).toContain("Respond as JSON matching this schema:");
    expect(prompt).toContain(JSON.stringify(replySchema()));
    expect(replySchema()).toMatchObject({ required: ["Inventory"], additionalProperties: false });
  });
});

describe("the tool", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "wm-sites-"));
    writeFileSync(join(directory, "isjac.yaml"), "name: isjac\nurl: https://www.isjac.org\nhost:\n  transport: ssh\n  target: isjac-host\n  wp_root: /var/www/isjac/httpdocs\n");
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const releaseNet = () =>
    new FakeSecurityNet({ [RELEASES_URL]: { status: 200, contentType: "application/json", body: JSON.stringify({ offers: [{ current: "6.7.1" }, { current: "6.4.5" }] }) } });
  /** A server that prints the lists the fixtures show, for the three commands the inventory reads. */
  const runs: string[] = [];
  const run: RunProcess = async (command, args): Promise<ProcessResult> => {
    runs.push([command, ...args].join(" "));
    const remote = args.at(-1) ?? "";
    if (remote.endsWith(" core version")) return { code: 0, stdout: "6.7.1\n", stderr: "" };
    if (remote.includes("plugin list")) return { code: 0, stdout: JSON.stringify(plugins), stderr: "" };
    if (remote.includes("theme list")) return { code: 0, stdout: JSON.stringify(themes), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected command: ${remote}` };
  };
  const refuse: RunProcess = async () => {
    throw new Error("nothing may run");
  };

  it("loads against omp's own zod, accepts valid and null-optional input, refuses an invalid one", async () => {
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { run: refuse, model: model([]), environment: {} });
    expect(tool.name).toBe("webmaster_wordpress_inventory");
    const schema = tool.parameters as { safeParse(value: unknown): { success: boolean } };
    expect(schema.safeParse({ site: "isjac.org" }).success).toBe(true);
    expect(schema.safeParse({ site: "isjac.org", server: null }).success).toBe(true);
    expect(schema.safeParse({ site: "isjac.org", server: { transport: "ssh", target: "h", wp_root: "/w", wp_cli: null } }).success).toBe(true);
    expect(schema.safeParse({ site: "isjac.org", server: { transport: "ssh" } }).success).toBe(false);
    expect(schema.safeParse({ site: "" }).success).toBe(false);
  });

  it("makes no connection and no model call, and says why, when server checks are off", async () => {
    const step = model([new Error("no model call expected")]);
    const net = releaseNet();
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, { run: refuse, model: step, net, sitesDirectory: directory, environment: {} });
    const result = await tool.execute("id", { site: "isjac.org" }, undefined, undefined);
    expect(result.details).toEqual({ site: "isjac.org", inventory: { status: "unmeasured", reason: SERVER_OFF_REASON } });
    expect(step.prompts).toHaveLength(0);
    expect(net.sent).toEqual([]);
  });

  it("with the switch on, reads only the three fixed commands over SSH, the releases and one model call", async () => {
    runs.length = 0;
    const step = model([reply()]);
    const net = releaseNet();
    const tool = makeTool({ zod: await loadZod(), cwd: "." } as never, {
      run, model: step, net, sitesDirectory: directory, environment: { WEBMASTER_SECURITY_SERVER: "1" }, now: () => "T",
    });
    const result = await tool.execute("id", { site: "https://www.isjac.org/shop" }, undefined, undefined);
    expect(result.details.site).toBe("isjac.org");
    const inventory = measured(result.details);
    expect(inventory.core).toMatchObject({ installed_version: "6.7.1", latest_version: "6.7.1", up_to_date: "yes" });
    expect(inventory.plugins.find((plugin) => plugin.slug === "woocommerce-subscriptions")).toMatchObject({ up_to_date: "no" });
    expect(runs).toHaveLength(INVENTORY_COMMANDS.length);
    expect(runs.every((line) => /^ssh -o BatchMode=yes -o ConnectTimeout=15 isjac-host /.test(line))).toBe(true);
    expect(net.sent).toEqual([{ method: "GET", url: RELEASES_URL }]);
    expect(step.prompts).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it("is unmeasured, asking nothing further, when no host is known or the session does not open", async () => {
    const zod = await loadZod();
    const step = model([new Error("no model call expected")]);
    const net = releaseNet();
    const noHost = makeTool({ zod, cwd: "." } as never, { run: refuse, model: step, net, sitesDirectory: join(tmpdir(), "no-such-dir"), environment: { WEBMASTER_SECURITY_SERVER: "1" } });
    expect((await noHost.execute("id", { site: "example.net" }, undefined, undefined)).details.inventory).toMatchObject({ status: "unmeasured", reason: expect.stringMatching(/no host block/) });
    const refused: RunProcess = async () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey).\n" });
    const down = makeTool({ zod, cwd: "." } as never, { run: refused, model: step, net, sitesDirectory: directory, environment: { WEBMASTER_SECURITY_SERVER: "1" } });
    expect((await down.execute("id", { site: "isjac.org" }, undefined, undefined)).details.inventory).toEqual({ status: "unmeasured", reason: "ssh isjac-host: Permission denied (publickey)." });
    expect(step.prompts).toHaveLength(0);
    expect(net.sent).toEqual([]);
    await expect(noHost.execute("id", { site: "not a host" }, undefined, undefined)).rejects.toThrow(/not a domain or address/);
  });
});

describe("the description", () => {
  it("is one dense block of 80-250 words naming the gate, the model and the boundary", () => {
    const words = DESCRIPTION.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    expect(words).toBeLessThanOrEqual(250);
    expect(DESCRIPTION).toContain("WEBMASTER_SECURITY_SERVER=1");
    expect(DESCRIPTION).toContain("omp -p");
    expect(DESCRIPTION).toContain("never says an item is vulnerable");
  });
});

describe("the WordPress.org release list", () => {
  it("reads the trimmed real answer: newest release of every branch once, newest first", async () => {
    const { releasesFrom } = await import("./releases.ts");
    const versions = releasesFrom(readFileSync(new URL("./fixtures/version-check-1.7.json", import.meta.url), "utf8"));
    expect(versions[0]).toBe("7.1.3");
    expect(new Set(versions.map((version) => version.split(".").slice(0, 2).join("."))).size).toBe(versions.length);
    expect(() => releasesFrom("{}")).toThrow(/no offers/);
  });

  it("is unmeasured with why when the read fails, and leaves core's latest unknown", async () => {
    const { readReleases } = await import("./releases.ts");
    const failing = new FakeSecurityNet({ [RELEASES_URL]: new Error("ECONNRESET") });
    expect(await readReleases(failing)).toEqual({ status: "unmeasured", reason: "the WordPress releases are unknown: ECONNRESET" });
    const controller = new AbortController();
    controller.abort();
    await expect(readReleases(new FakeSecurityNet(), controller.signal)).rejects.toThrow();
  });
});
