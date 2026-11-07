import { join } from "node:path";
import type { Asset, ServerAsset, SiteAsset } from "./asset.ts";
import { SSH_TARGET } from "./inventory_facts.ts";
import { type Machine, siteContextNamed, siteNames } from "./machine.ts";

/**
 * What the owner has access to: the servers in the SSH config (and the ones site files name), and the sites with a
 * site file. Reads files and runs only `ssh -G`, which prints the settings the config resolves to and connects to nothing.
 */

const INCLUDE_DEPTH = 2;

/** The patterns of one `Host` line that name a single machine: no wildcard, no negation. */
const concreteNames = (patterns: readonly string[]): string[] =>
  patterns.filter((pattern) => !/[*?!]/.test(pattern) && SSH_TARGET.test(pattern));

/** A path an `Include` line names, `~` and relative paths resolved against `~/.ssh`. */
function includePath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path.startsWith("/") ? path : join(home, ".ssh", path);
}

/** The text of an SSH config and of the files it includes, in order. */
async function configTexts(machine: Machine, path: string, depth = 0): Promise<string[]> {
  const text = await machine.readTextFile(path);
  if (text === undefined) return [];
  const texts = [text];
  if (depth >= INCLUDE_DEPTH) return texts;
  for (const line of text.split("\n")) {
    const include = /^\s*Include\s+(.+?)\s*$/i.exec(line)?.[1];
    if (include === undefined) continue;
    for (const entry of include.split(/\s+/)) {
      const resolved = includePath(entry, machine.homeDirectory);
      if (entry.endsWith("/*")) {
        const directory = resolved.slice(0, -2);
        for (const name of await machine.listDirectory(directory)) {
          texts.push(...await configTexts(machine, join(directory, name), depth + 1));
        }
      } else {
        texts.push(...await configTexts(machine, resolved, depth + 1));
      }
    }
  }
  return texts;
}

/** Every `Host` line's concrete names, one list per line, in file order. */
export function sshHostLines(text: string): string[][] {
  const lines: string[][] = [];
  for (const line of text.split("\n")) {
    const patterns = /^\s*Host\s+(.+?)\s*$/i.exec(line)?.[1];
    if (patterns === undefined) continue;
    const names = concreteNames(patterns.split(/\s+/));
    if (names.length > 0) lines.push(names);
  }
  return lines;
}

interface Resolved {
  readonly hostname?: string;
  readonly port?: number;
  readonly user?: string;
}

/** What `ssh -G <name>` resolves a name to; nothing when it cannot say. */
async function resolve(machine: Machine, name: string): Promise<Resolved> {
  const result = await machine.run("ssh", ["-G", name]);
  if (result.code !== 0) return {};
  const value = (key: string): string | undefined => new RegExp(`^${key} (.+)$`, "m").exec(result.stdout)?.[1]?.trim();
  const port = Number(value("port"));
  const hostname = value("hostname");
  const user = value("user");
  return {
    ...(hostname === undefined ? {} : { hostname }),
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    ...(user === undefined ? {} : { user }),
  };
}

const keyOf = (name: string, resolved: Resolved): string =>
  resolved.hostname === undefined
    ? `name:${name}`
    : `${resolved.user ?? ""}@${resolved.hostname}:${resolved.port ?? 22}`;

/** The servers the SSH config names, one per machine however many names it gives it. */
export async function sshServers(machine: Machine): Promise<ServerAsset[]> {
  const texts = await configTexts(machine, join(machine.homeDirectory, ".ssh", "config"));
  const servers = new Map<string, ServerAsset>();
  for (const names of texts.flatMap(sshHostLines)) {
    const [name = "", ...rest] = names;
    const resolved = await resolve(machine, name);
    const key = keyOf(name, resolved);
    const known = servers.get(key);
    if (known === undefined) {
      servers.set(key, { kind: "server", name, target: name, ...resolved, aliases: rest, sites: [], source: "ssh_config" });
      continue;
    }
    const aliases = new Set([...known.aliases, name, ...rest]);
    aliases.delete(known.name);
    servers.set(key, { ...known, aliases: [...aliases] });
  }
  return [...servers.values()];
}

/** The sites that have a site file. A file that is not a site is skipped, never a reason to stop. */
export async function siteAssets(machine: Machine): Promise<SiteAsset[]> {
  const sites: SiteAsset[] = [];
  for (const name of await siteNames(machine)) {
    try {
      const context = await siteContextNamed(name, machine);
      sites.push({
        kind: "site",
        name: context.name,
        url: context.url,
        ...(context.platform === undefined ? {} : { platform: context.platform }),
        ...(context.tier === undefined ? {} : { tier: context.tier }),
        ...(context.security?.server === undefined ? {} : { server: context.security.server }),
      });
    } catch {
      continue;
    }
  }
  return sites;
}

const namesOf = (server: ServerAsset): string[] => [server.name, ...server.aliases];

/** Which servers and sites to look at, by name: all of them unless the caller names some. */
export interface AssetScope {
  readonly servers?: readonly string[];
  readonly sites?: readonly string[];
}

/** The assets `scope` names, by name or alias; every asset when it names none. */
export function narrowAssets(assets: readonly Asset[], scope: AssetScope): Asset[] {
  if (scope.servers === undefined && scope.sites === undefined) return [...assets];
  const named = (wanted: readonly string[] | undefined, own: readonly string[]): boolean =>
    wanted !== undefined && own.some((name) => wanted.includes(name));
  return assets.filter((asset) =>
    asset.kind === "server" ? named(scope.servers, namesOf(asset)) : named(scope.sites, [asset.name])
  );
}

/** Every server and site the owner has access to, each site linked to its server. */
export async function listAssets(machine: Machine): Promise<Asset[]> {
  const servers = await sshServers(machine);
  const sites = await siteAssets(machine);
  for (const site of sites) {
    if (site.server?.transport !== "ssh") continue;
    const target = site.server.target;
    const resolved = await resolve(machine, target);
    const machineOf = (server: { hostname?: string | undefined; port?: number | undefined }): string | undefined =>
      server.hostname === undefined ? undefined : `${server.hostname}:${server.port ?? 22}`;
    const wanted = machineOf(resolved);
    // A site file's `user@host` and the SSH config's alias for that host are one machine, however they are logged in to.
    const index = servers.findIndex((server) =>
      namesOf(server).includes(target) || (wanted !== undefined && machineOf(server) === wanted)
    );
    const found = servers[index];
    if (found !== undefined) {
      servers[index] = { ...found, sites: [...found.sites, site.name] };
    } else if (SSH_TARGET.test(target)) {
      servers.push({ kind: "server", name: target, target, ...resolved, aliases: [], sites: [site.name], source: "site_file" });
    }
  }
  return [...servers, ...sites];
}
