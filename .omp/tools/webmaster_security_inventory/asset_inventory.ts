import { connect } from "node:net";
import type { Asset, ServerAsset, SiteAsset } from "./asset.ts";
import type { AssetInventory, InventoryFact } from "./inventory_types.ts";
import {
  checkedPackages,
  type Fact,
  factScript,
  isServerFact,
  isSiteFact,
  readSections,
  remoteRunner,
  type ScriptedFact,
  SERVER_FACTS,
  serverCommand,
  SITE_FACTS,
  SSH_TARGET,
} from "./inventory_facts.ts";
import type { Machine } from "./machine.ts";
import { publicGet, redactSecrets } from "./net.ts";
import type { SiteServer } from "./site_context.ts";
import { commandBuilders, SSH_FAILED, SSH_OPTIONS } from "./wp_ssh.ts";

/**
 * The fixed read-only facts of one asset. Read-only by construction: every command is built from constants in
 * `inventory_facts.ts` (the only values put in are plain words: package names, the target, the site file's WP-CLI
 * prefixes), and nothing else can be asked for. Authentication is the SSH agent's: no password, key or token is read
 * from a file or the environment. `WEBMASTER_SECURITY_SERVER=0` switches the SSH reads off.
 */

export const SERVER_SWITCH_ENVIRONMENT = "WEBMASTER_SECURITY_SERVER";
export const SERVER_SWITCHED_OFF_REASON =
  "SSH reads are switched off: WEBMASTER_SECURITY_SERVER=0 (unset it, or set it to 1, to read servers)";
const BANNER_TIMEOUT_MS = 5000;
const HEADERS_TIMEOUT_MS = 15_000;
const BODY_CAP = 100_000;
const BANNER_CAP = 255;

/** The reads that reach the network without SSH; tests pass recorded ones. */
export interface InventoryNet {
  /** The first line a daemon sends when a client connects, or throws why none came. */
  banner(host: string, port: number): Promise<string>;
  /** The home page's status, headers and the start of its body, or throws why none came. */
  home(url: string): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: string }>;
}

export const systemInventoryNet: InventoryNet = {
  banner(host, port) {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const socket = connect({ host, port });
    let seen = "";
    const settle = (answer: () => void) => {
      socket.destroy();
      answer();
    };
    socket.setTimeout(
      BANNER_TIMEOUT_MS,
      () => settle(() => reject(new Error(`no banner from ${host}:${port} in ${BANNER_TIMEOUT_MS} ms`))),
    );
    socket.on("error", (error) => settle(() => reject(error)));
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      const newline = seen.indexOf("\n");
      if (newline >= 0 || seen.length >= BANNER_CAP) {
        settle(() => resolve(seen.slice(0, newline >= 0 ? newline : BANNER_CAP).trim()));
      }
    });
    socket.on("close", () => {
      if (seen === "") reject(new Error(`${host}:${port} closed without a banner`));
      else resolve(seen.trim());
    });
    return promise;
  },
  async home(url) {
    return await publicGet(url, {
      headers: { "user-agent": "capability-replicas-webmaster-security/1.0 (+read-only check)" },
      timeoutMs: HEADERS_TIMEOUT_MS,
      bodyCap: BODY_CAP,
    });
  },
};

export interface InventoryDeps {
  readonly net?: InventoryNet;
  /** A fresh unguessable word that marks one script's sections. */
  readonly nonce?: () => string;
  readonly now?: () => string;
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
const notRead = (fact: Fact, command_line: string, why: string): InventoryFact => ({ fact, command_line, code: -1, output: why });

/** The facts to read when the caller names none. */
export function defaultFacts(asset: Asset, packages: readonly string[]): Fact[] {
  if (asset.kind === "site") return [...SITE_FACTS];
  return SERVER_FACTS.filter((fact) => fact !== "packages" || packages.length > 0);
}

/**
 * The last SSH session queued for each target. Hosts such as WP Engine allow one session at a time (a site file says so
 * with `max_concurrent_ssh: 1`), and a server and a site can name the same target, so sessions to one target never overlap.
 */
const lastSession = new Map<string, Promise<unknown>>();

function serially<T>(target: string, work: () => Promise<T>): Promise<T> {
  // `site@host` and the alias `host` reach one machine, so the user part is not part of the queue's name.
  const queue = target.slice(target.lastIndexOf("@") + 1);
  const run = (lastSession.get(queue) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  lastSession.set(queue, tail);
  void tail.then(() => {
    if (lastSession.get(queue) === tail) lastSession.delete(queue);
  });
  return run;
}

/** Runs the scripted facts in one SSH session and reads each fact's section back; a fact with none was not read. */
async function overSsh(
  target: string,
  scripted: readonly ScriptedFact[],
  machine: Machine,
  nonce: string,
): Promise<InventoryFact[]> {
  if (scripted.length === 0) return [];
  if (machine.environment(SERVER_SWITCH_ENVIRONMENT) === "0") {
    return scripted.map(({ fact, command_line }) => notRead(fact, command_line, SERVER_SWITCHED_OFF_REASON));
  }
  if (!SSH_TARGET.test(target)) {
    return scripted.map(({ fact, command_line }) => notRead(fact, command_line, `"${target}" is not a plain SSH target`));
  }
  const result = await serially(target, () =>
    machine.run("ssh", [
      ...SSH_OPTIONS,
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      target,
      remoteRunner(factScript(scripted, nonce)),
    ]));
  const sections = readSections(result.stdout, nonce);
  const why = result.code === SSH_FAILED || result.code === -1
    ? `ssh ${target} did not connect: ${result.stderr.trim().split("\n")[0] || "no reason given"}`
    : `ssh ${target} printed nothing for this fact (exit ${result.code}): ${result.stderr.trim().split("\n")[0] ?? ""}`;
  return scripted.map(({ fact, command_line }) => {
    const section = sections.get(fact);
    return section === undefined
      ? notRead(fact, command_line, why)
      : { fact, command_line, code: section.code, output: redactSecrets(section.output) };
  });
}

/** The inventory of the facts read: `unmeasured` when none could be read at all. */
function inventoryOf(facts: readonly InventoryFact[], now: () => string): AssetInventory {
  const read = facts.filter((fact) => fact.code !== -1);
  if (read.length === 0) {
    const reasons = [...new Set(facts.map((fact) => fact.output))].join("; ");
    return { status: "unmeasured", reason: reasons === "" ? "no facts were asked for" : reasons };
  }
  return { status: "measured", measured_at: now(), facts: [...facts] };
}

/** Reads a server's facts: its SSH banner from the network, the rest over one SSH session. */
export async function measureServer(
  asset: ServerAsset,
  facts: readonly Fact[],
  packages: readonly string[],
  machine: Machine,
  deps: InventoryDeps = {},
): Promise<AssetInventory> {
  const wanted = SERVER_FACTS.filter((fact) => facts.includes(fact));
  const scripted: ScriptedFact[] = [];
  const unreadable: InventoryFact[] = [];
  for (const fact of wanted) {
    if (fact === "ssh_banner") continue;
    if (fact === "packages" && packages.length === 0) {
      unreadable.push(notRead(fact, "packages", "no package names were given"));
      continue;
    }
    scripted.push({ fact, command_line: serverCommand(fact, fact === "packages" ? checkedPackages(packages) : []) });
  }
  const net = deps.net ?? systemInventoryNet;
  const bannerFact: InventoryFact[] = [];
  if (wanted.includes("ssh_banner")) {
    const host = asset.hostname ?? asset.target;
    const port = asset.port ?? 22;
    const command_line = `tcp connect ${host}:${port}, read the first line`;
    try {
      bannerFact.push({ fact: "ssh_banner", command_line, code: 0, output: await net.banner(host, port) });
    } catch (error) {
      bannerFact.push(notRead("ssh_banner", command_line, describe(error)));
    }
  }
  const nonce = deps.nonce?.() ?? crypto.randomUUID().replaceAll("-", "");
  const read = await overSsh(asset.target, scripted, machine, nonce);
  const byFact = new Map([...read, ...unreadable, ...bannerFact].map((entry) => [entry.fact, entry]));
  return inventoryOf(wanted.flatMap((fact) => byFact.get(fact) ?? []), deps.now ?? (() => new Date().toISOString()));
}

/** What the home page's headers say, as the lines a reader would want. */
function headerLines(home: { status: number; headers: Readonly<Record<string, string>>; body: string }): string {
  const lines = [`status: ${home.status}`];
  for (const name of ["server", "x-powered-by", "x-generator", "via"]) {
    const value = home.headers[name];
    if (value !== undefined) lines.push(`${name}: ${value}`);
  }
  const generator = /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i.exec(home.body)?.[1]
    ?? /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i.exec(home.body)?.[1];
  if (generator !== undefined) lines.push(`generator meta: ${generator}`);
  return lines.join("\n");
}

/** The fixed WP-CLI commands for a site's WordPress facts, with plugins and themes left unloaded. */
function wordpressCommands(server: SiteServer, facts: readonly Fact[]): ScriptedFact[] {
  const { wpCli } = commandBuilders(server);
  const commands: Partial<Record<Fact, string>> = {
    wp_core_version: wpCli("core", "version"),
    wp_plugins: wpCli("plugin", "list", "--fields=name,status,version", "--format=json"),
    wp_themes: wpCli("theme", "list", "--fields=name,status,version", "--format=json"),
  };
  return facts.flatMap((fact) => commands[fact] === undefined ? [] : [{ fact, command_line: commands[fact] }]);
}

/** A site's WordPress facts, read over SSH when the site file says how to reach the server. */
async function wordpressFacts(
  server: SiteServer | undefined,
  facts: readonly Fact[],
  machine: Machine,
  nonce: string,
): Promise<InventoryFact[]> {
  const refuse = (why: string) => facts.map((fact) => notRead(fact, fact, why));
  if (server === undefined) return refuse("the site file names no host block, so WordPress cannot be read");
  if (server.transport !== "ssh") return refuse(`the site's host is reached by ${server.transport}, not SSH`);
  try {
    return await overSsh(server.target, wordpressCommands(server, facts), machine, nonce);
  } catch (error) {
    return refuse(describe(error));
  }
}

/** Reads a site's facts: its home page's headers from the network, WordPress over SSH when its site file says how. */
export async function measureSite(
  asset: SiteAsset,
  facts: readonly Fact[],
  machine: Machine,
  deps: InventoryDeps = {},
): Promise<AssetInventory> {
  const wanted = SITE_FACTS.filter((fact) => facts.includes(fact));
  const read = new Map<Fact, InventoryFact>();
  if (wanted.includes("web_headers")) {
    const command_line = `GET ${asset.url}`;
    try {
      read.set("web_headers", {
        fact: "web_headers",
        command_line,
        code: 0,
        output: headerLines(await (deps.net ?? systemInventoryNet).home(asset.url)),
      });
    } catch (error) {
      read.set("web_headers", notRead("web_headers", command_line, describe(error)));
    }
  }
  const wordpress = wanted.filter((fact) => fact !== "web_headers");
  if (wordpress.length > 0) {
    const nonce = deps.nonce?.() ?? crypto.randomUUID().replaceAll("-", "");
    for (const entry of await wordpressFacts(asset.server, wordpress, machine, nonce)) read.set(entry.fact, entry);
  }
  return inventoryOf(wanted.flatMap((fact) => read.get(fact) ?? []), deps.now ?? (() => new Date().toISOString()));
}

/** Reads the asset's facts: the ones named, or the ones that apply to its kind. */
export function measureAsset(
  asset: Asset,
  facts: readonly Fact[] | undefined,
  packages: readonly string[],
  machine: Machine,
  deps: InventoryDeps = {},
): Promise<AssetInventory> {
  const asked = facts ?? defaultFacts(asset, packages);
  if (asset.kind === "server") return measureServer(asset, asked.filter(isServerFact), packages, machine, deps);
  return measureSite(asset, asked.filter(isSiteFact), machine, deps);
}
