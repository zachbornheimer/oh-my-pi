/**
 * The WordPress inventory: installed versus latest for core, every plugin and every theme. Every version and every
 * up-to-date answer is read from the evidence collected (`wp plugin list`, `wp theme list`, `wp core version`,
 * WordPress.org's releases); the model is asked only for the official URL, a clean name and notes, and whatever else it
 * returns is dropped. Port of the `@zab-ai/ai` kit's `tools/wordpress_inventory`.
 */

export const NO_INSPECTION_REASON = "nothing was collected: this host ran no inspection for the site";
const CORE_SLUG = "wordpress";
const RELEASE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
/** WP-CLI statuses of software that is not updated through a channel. */
const NO_UPDATE_CHANNEL = ["must-use", "dropin"];
/** Exit codes that mean the command did not run at all: ssh failed, the binary is missing, it could not start. */
const DID_NOT_RUN = new Set([-1, 126, 127, 255]);

export type UpToDate = "yes" | "no" | "unknown";

/** One piece of software on the site: core, a plugin or a theme. Versions are measured; the rest is the model's. */
export interface InventoryItem {
  slug: string;
  name: string;
  status: string;
  installed_version: string | null;
  latest_version: string | null;
  up_to_date: UpToDate;
  official_url: string | null;
  suspicious: string[];
}

export type Inventory =
  | {
      status: "measured";
      core: InventoryItem;
      plugins: InventoryItem[];
      themes: InventoryItem[];
      judgment_unavailable?: string;
    }
  | { status: "unmeasured"; reason: string };

export interface InventoryOutput {
  site: string;
  inventory: Inventory;
}

/** What the model may say about one item; any version it returns is dropped. */
export interface ModelNote {
  slug: string;
  name: string;
  official_url: string | null;
  suspicious: string[];
}

export interface InventoryReply {
  Inventory: { core: ModelNote; plugins: ModelNote[]; themes: ModelNote[] };
}

/** One command the inspection ran on the site's server. */
export interface InspectRow {
  command: string;
  command_line: string;
  code: number;
  stdout: string;
  stderr: string;
}

export type InventoryInspect =
  | { status: "measured"; outputs: readonly InspectRow[] }
  | { status: "unmeasured"; reason: string };

export type InventoryPublicApi =
  | { status: "measured"; releases: { status: "measured"; versions: readonly string[] } | { status: "unmeasured"; reason: string } }
  | { status: "unmeasured"; reason: string };

export interface InventoryEvidence {
  readonly site: string;
  readonly inspect?: InventoryInspect;
  readonly public_api?: InventoryPublicApi;
}

/** What the tool provides: the one model call, with the reply shape validated in code. */
export interface InventoryPorts {
  /**
   * Asks the model `prompt`; resolves to the reply passed through `accept`. `accept` throws to reject a reply, and the
   * implementation asks again with the reason. Throws when the model cannot answer.
   */
  judge(request: { readonly prompt: string; readonly accept: (reply: unknown) => InventoryReply }): Promise<InventoryReply>;
  /** Renders the model's prompt from the evidence text. */
  readonly prompt: (evidence: string) => string;
}

type Row = InspectRow;
type MeasuredInspect = Extract<InventoryInspect, { status: "measured" }>;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** A row's field as text; empty when it is missing or not a string or number. */
function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The rows a WP-CLI `--format=json` command printed, or undefined when it printed something else. */
function jsonRows(stdout: string): Record<string, unknown>[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  } catch {
    return undefined;
  }
}

/** The command's row when it ran, else why the inventory cannot read it. */
function ranRow(inspect: MeasuredInspect, command: string): Row | { readonly unmeasured: string } {
  const row = inspect.outputs.find((each) => each.command === command);
  if (row === undefined) return { unmeasured: `the inspection did not run \`${command}\`` };
  if (DID_NOT_RUN.has(row.code)) {
    return { unmeasured: `\`${row.command_line}\` did not run (exit ${row.code}): ${firstLine(row.stderr)}` };
  }
  return row;
}

const unreadable = (row: Row): { readonly unmeasured: string } => ({
  unmeasured: `could not read the output of \`${row.command_line}\`: ${firstLine(row.stdout || row.stderr)}`,
});

const numbers = (version: string): number[] => version.split(".").map((part) => Number.parseInt(part, 10));

/** -1, 0 or 1 comparing dotted release numbers; undefined when either is not one. */
function compareReleases(a: string, b: string): number | undefined {
  if (!RELEASE_VERSION.test(a) || !RELEASE_VERSION.test(b)) return undefined;
  const [left, right] = [numbers(a), numbers(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const branchOf = (version: string): string => version.split(".").slice(0, 2).join(".");

/** Core: the installed version from `core_version`, the latest from the WordPress.org releases of its branch. */
function coreItem(inspect: MeasuredInspect, publicApi: InventoryPublicApi | undefined): InventoryItem {
  const base = { slug: CORE_SLUG, name: "WordPress", status: "installed", official_url: null };
  const row = ranRow(inspect, "core_version");
  const installed = "unmeasured" in row
    ? undefined
    : row.code === 0
    ? linesOf(row.stdout).find((line) => RELEASE_VERSION.test(line))
    : undefined;
  if (installed === undefined) {
    const why = "unmeasured" in row ? row.unmeasured : unreadable(row).unmeasured;
    return {
      ...base,
      installed_version: null,
      latest_version: null,
      up_to_date: "unknown",
      suspicious: [`WordPress core reports no readable version: ${why}`],
    };
  }
  if (publicApi?.status !== "measured" || publicApi.releases.status !== "measured") {
    return { ...base, installed_version: installed, latest_version: null, up_to_date: "unknown", suspicious: [] };
  }
  const { versions } = publicApi.releases;
  const sameBranch = versions.find((version) => branchOf(version) === branchOf(installed));
  const latest = sameBranch ?? versions[0] ?? null;
  const order = latest === null ? undefined : compareReleases(installed, latest);
  return {
    ...base,
    installed_version: installed,
    latest_version: latest,
    up_to_date: order === undefined ? "unknown" : order < 0 ? "no" : order === 0 ? "yes" : "unknown",
    suspicious: sameBranch === undefined && latest !== null
      ? [`WordPress ${installed} is on a branch WordPress.org no longer releases; the newest release is ${latest}.`]
      : [],
  };
}

/** One row of `wp plugin list` or `wp theme list`, as printed. Versions come from here and nowhere else. */
function listedItem(row: Record<string, unknown>): InventoryItem {
  const slug = field(row, "name");
  const status = field(row, "status");
  const version = field(row, "version");
  const update = field(row, "update");
  const updateVersion = field(row, "update_version");
  const suspicious: string[] = [];
  let latest: string | null = null;
  let upToDate: UpToDate = "unknown";
  if (NO_UPDATE_CHANNEL.includes(status)) {
    suspicious.push(`${slug} is a ${status === "dropin" ? "drop-in" : "must-use plugin"}: it has no update channel.`);
  } else if (update === "available" && updateVersion !== "") {
    [latest, upToDate] = [updateVersion, "no"];
  } else if (update === "none" && version !== "") {
    [latest, upToDate] = [version, "yes"];
  } else {
    suspicious.push(`${slug}: the site's update channel reports nothing about it (update: ${update || "empty"}).`);
  }
  if (version === "") suspicious.push(`${slug} has no version.`);
  return {
    slug,
    name: field(row, "title") || slug,
    status,
    installed_version: version === "" ? null : version,
    latest_version: latest,
    up_to_date: upToDate,
    official_url: null,
    suspicious,
  };
}

function listed(inspect: MeasuredInspect, command: string): InventoryItem[] | { readonly unmeasured: string } {
  const row = ranRow(inspect, command);
  if ("unmeasured" in row) return row;
  const rows = row.code === 0 ? jsonRows(row.stdout) : undefined;
  return rows === undefined ? unreadable(row) : rows.map(listedItem).filter((item) => item.slug !== "");
}

const orNone = (value: string | null): string => value ?? "none";

/** The evidence the model reads: one line per item, in the form the question file's example shows. */
export function evidenceOf(
  site: string,
  core: InventoryItem,
  plugins: readonly InventoryItem[],
  themes: readonly InventoryItem[],
): string {
  const line = (item: InventoryItem, withStatus: boolean): string =>
    `- ${item.slug} | ${item.name} | ${withStatus ? `${item.status} | ` : ""}installed ${
      orNone(item.installed_version)
    } | latest ${orNone(item.latest_version)}`;
  return [
    `Site: ${site}`,
    "",
    "## Core",
    line(core, false),
    "",
    "## Plugins",
    ...plugins.map((item) => line(item, true)),
    "",
    "## Themes",
    ...themes.map((item) => line(item, true)),
  ].join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function noteOf(value: unknown, where: string): ModelNote {
  if (!isRecord(value)) throw new Error(`${where}: expected an object with slug, name, official_url and suspicious`);
  const { slug, name, official_url: url, suspicious } = value;
  if (typeof slug !== "string" || slug === "") throw new Error(`${where}.slug: expected a non-empty string`);
  if (typeof name !== "string" || name === "") throw new Error(`${where}.name: expected a non-empty string`);
  if (url !== null && typeof url !== "string") throw new Error(`${where}.official_url: expected a string or null`);
  if (!Array.isArray(suspicious) || suspicious.some((note) => typeof note !== "string" || note === "")) {
    throw new Error(`${where}.suspicious: expected an array of non-empty strings`);
  }
  // Only these four fields are kept: any version the model returns is dropped here, so it cannot overwrite a measurement.
  return { slug, name, official_url: url, suspicious: [...(suspicious as string[])] };
}

/** The model's reply as the notes it may give. Throws, naming the field, when the reply is not that shape. */
export function parseReply(value: unknown): InventoryReply {
  if (!isRecord(value) || !isRecord(value["Inventory"])) throw new Error("expected an object with an `Inventory` object");
  const inventory = value["Inventory"];
  const list = (key: "plugins" | "themes"): ModelNote[] => {
    const items = inventory[key];
    if (!Array.isArray(items)) throw new Error(`Inventory.${key}: expected an array`);
    return items.map((item, index) => noteOf(item, `Inventory.${key}[${index}]`));
  };
  return { Inventory: { core: noteOf(inventory["core"], "Inventory.core"), plugins: list("plugins"), themes: list("themes") } };
}

/** Refuses a reply that leaves a listed item out, so the model is told which and asks again. */
export function requireEveryItem(reply: InventoryReply, expected: readonly string[]): InventoryReply {
  const { core, plugins, themes } = reply.Inventory;
  const named = new Set([core.slug, ...plugins.map((item) => item.slug), ...themes.map((item) => item.slug)]);
  const missing = expected.filter((slug) => !named.has(slug));
  if (missing.length > 0) throw new Error(`the reply leaves out: ${missing.join(", ")}; return every listed item`);
  return reply;
}

/** The measured item with only the model's name, URL and notes added; versions and up_to_date stay as measured. */
function withJudgment(item: InventoryItem, judged: ModelNote | undefined): InventoryItem {
  if (judged === undefined) return item;
  const suspicious = [...item.suspicious];
  for (const note of judged.suspicious) if (!suspicious.includes(note)) suspicious.push(note);
  if (judged.official_url === null && !suspicious.some((note) => /official/i.test(note))) {
    suspicious.push(`${item.slug}: no known official source.`);
  }
  return {
    ...item,
    name: judged.name.trim() === "" ? item.name : judged.name,
    official_url: judged.official_url,
    suspicious,
  };
}

/**
 * The inventory from the evidence. `unmeasured` with a reason when the inspection was not measured or its plugin or
 * theme list could not be read; a model that cannot answer leaves the versions and sets `judgment_unavailable`.
 */
export async function runInventory(input: InventoryEvidence, ports: InventoryPorts): Promise<InventoryOutput> {
  const { site } = input;
  const inspect = input.inspect ?? { status: "unmeasured" as const, reason: NO_INSPECTION_REASON };
  if (inspect.status !== "measured") return { site, inventory: { status: "unmeasured", reason: inspect.reason } };
  const plugins = listed(inspect, "plugin_list");
  if ("unmeasured" in plugins) return { site, inventory: { status: "unmeasured", reason: plugins.unmeasured } };
  const themes = listed(inspect, "theme_list");
  if ("unmeasured" in themes) return { site, inventory: { status: "unmeasured", reason: themes.unmeasured } };
  const core = coreItem(inspect, input.public_api);
  const slugs = [core.slug, ...plugins.map((item) => item.slug), ...themes.map((item) => item.slug)];
  let judged: InventoryReply["Inventory"] | undefined;
  let judgment_unavailable: string | undefined;
  try {
    const reply = await ports.judge({
      prompt: ports.prompt(evidenceOf(site, core, plugins, themes)),
      accept: (parsed) => requireEveryItem(parseReply(parsed), slugs),
    });
    judged = reply.Inventory;
  } catch (error) {
    // A cancelled run is not a model that could not answer.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    judgment_unavailable = `the model's official URLs and notes are missing: ${error instanceof Error ? error.message : String(error)}`;
  }
  const by = (items: readonly ModelNote[] | undefined, slug: string) => items?.find((item) => item.slug === slug);
  const inventory: Inventory = {
    status: "measured",
    core: withJudgment(core, judged?.core),
    plugins: plugins.map((item) => withJudgment(item, by(judged?.plugins, item.slug))),
    themes: themes.map((item) => withJudgment(item, by(judged?.themes, item.slug))),
    ...(judgment_unavailable === undefined ? {} : { judgment_unavailable }),
  };
  return { site, inventory };
}
