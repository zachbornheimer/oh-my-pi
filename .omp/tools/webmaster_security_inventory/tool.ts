import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type Asset, assetLabel } from "./asset.ts";
import { type InventoryDeps, measureAsset } from "./asset_inventory.ts";
import { listAssets } from "./assets.ts";
import { checkedPackages, FACTS, type Fact, isFact, MAX_PACKAGES } from "./inventory_facts.ts";
import type { AssetInventory } from "./inventory_types.ts";
import { type Machine, type ProcessResult, type RunProcess, systemMachine } from "./machine.ts";

/** The longest one process (an SSH session) may run before it is stopped and recorded as not run. */
export const COMMAND_TIMEOUT_MS = 300_000;

export interface InventoryToolDeps extends InventoryDeps {
  /** The machine the assets and facts are read through; the factory builds the real one from `pi.exec`. */
  machine?: (signal: AbortSignal | undefined) => Machine;
  run?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
}

type Pi = Parameters<CustomToolFactory>[0];

export const DESCRIPTION =
  "Read a fixed list of facts about one server over SSH (operating system, kernel and its package, libc, installed versions of the package names you give, SSH daemon settings, whether sshd links PAM, how many shadow accounts hold a bare `*` (never a hash), listening ports, eight kernel security settings, the SSH banner) or about one site (its web server headers and generator, and over SSH its WordPress core, plugin and theme versions), and record what each printed. "
  + "Use it for the raw facts; it never says what they mean (webmaster_security_risk_check judges advisories against them) and runs nothing outside its fixed list. Nothing is written on the asset. "
  + "Input: `{\"asset\":\"server:zysys\"}`, `{\"asset\":\"site:isjac\",\"facts\":[\"web_headers\"]}` or `{\"asset\":\"alpine\",\"facts\":[\"packages\"],\"package_names\":[\"openssh-server\"]}`. `asset` is `server:<name>`, `site:<name>` or a bare name (the server of that name, else the site), from `~/.ssh/config` (and `ssh -G`, which connects to nothing) and the site files under `WEBMASTER_SITES_DIR` (default `~/Developer/Zysys/webmaster/sites`). `facts` default to every fact that fits the asset; `package_names` (lowercase, at most 12) feed `packages`. "
  + "A server read is one SSH session (BatchMode, SSH agent only), sessions to one host run one at a time, plus one TCP connect to its SSH port for the banner; a site read is one public GET of its home page plus one SSH session for WordPress facts. `WEBMASTER_SECURITY_SERVER=0` switches SSH off. "
  + "Result: `{asset, inventory}`; `inventory` is `measured` with `facts[]` (`fact`, `command_line`, `code`, `output`; code -1 means not read, with why) or `unmeasured` with a reason when nothing could be read.";

/** The real runner: omp's `exec`, a stopped command recorded as code -1, a cancelled run thrown. */
export function runWithPi(pi: Pi): RunProcess {
  return async (command, args, signal) => {
    const result = await pi.exec(command, [...args], { cwd: pi.cwd, timeout: COMMAND_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    const out: ProcessResult = {
      code: result.killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.killed ? `${result.stderr}\nstopped after ${COMMAND_TIMEOUT_MS} ms`.trim() : result.stderr,
    };
    return out;
  };
}

/** `[server:|site:]<name>`: a bare name is the server of that name (or one of its aliases), else the site. */
export async function findAsset(word: string, machine: Machine): Promise<Asset> {
  const name = word.trim();
  if (name === "") throw new Error('asset needs a server or site name, such as "server:zysys"');
  const [, kind, bare = name] = /^(server|site):(.+)$/.exec(name) ?? [];
  const assets = await listAssets(machine);
  const asset = assets.find(
    (each) => (kind === undefined || each.kind === kind) && (each.name === bare || (each.kind === "server" && each.aliases.includes(bare))),
  );
  if (asset === undefined) {
    throw new Error(`no server or site is named "${bare}"; known: ${assets.map((each) => assetLabel(each)).join(", ")}`);
  }
  return asset;
}

export function makeTool(pi: Pi, deps: InventoryToolDeps = {}) {
  const z = pi.zod;
  const run = deps.run ?? runWithPi(pi);
  const { machine: makeMachine, run: _run, environment, ...inventoryDeps } = deps;
  return {
    name: "webmaster_security_inventory",
    label: "Security inventory",
    description: DESCRIPTION,
    parameters: z.object({
      asset: z.string().min(1).describe("`server:<name>`, `site:<name>` or a bare name: the server of that name, else the site."),
      facts: z.array(z.string()).nullable().optional().describe(
        `Facts to read; omit for every fact that fits the asset's kind. One of: ${FACTS.join(", ")}.`,
      ),
      package_names: z.array(z.string()).nullable().optional().describe(
        `Package names the \`packages\` fact reads the installed version of: lowercase, as the distro spells them, at most ${MAX_PACKAGES}.`,
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { asset: string; facts?: string[] | null; package_names?: string[] | null },
      _onUpdate: unknown,
      _ctx: unknown,
      signal?: AbortSignal,
    ) {
      let facts: Fact[] | undefined;
      if (params.facts != null) {
        const bad = params.facts.find((fact) => !isFact(fact));
        if (bad !== undefined) throw new Error(`"${bad}" is not a fact; the facts are: ${FACTS.join(", ")}`);
        facts = params.facts as Fact[];
      }
      const packages = checkedPackages(params.package_names ?? []);
      const machine = makeMachine?.(signal) ?? systemMachine(run, { ...(signal === undefined ? {} : { signal }), ...(environment === undefined ? {} : { environment }) });
      const asset = await findAsset(params.asset, machine);
      const inventory: AssetInventory = await measureAsset(asset, facts, packages, machine, inventoryDeps);
      signal?.throwIfAborted();
      const result = { asset: assetLabel(asset), inventory };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
