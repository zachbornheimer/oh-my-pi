import type { SiteServer } from "./site_context.ts";

/**
 * The things an advisory can hurt: a server the owner reaches over SSH, and a site the owner runs. Plumbing only: the
 * tool lists them, `webmaster_security_inventory` reads their facts, `webmaster_security_risk_check` judges them.
 */

export interface ServerAsset {
  kind: "server";
  /** The server's name: its first SSH host alias. */
  name: string;
  /** What `ssh` is given to reach it: an alias or `user@host`. */
  target: string;
  /** The address `ssh -G` resolved the target to. */
  hostname?: string;
  /** The SSH port `ssh -G` resolved. */
  port?: number;
  /** The account `ssh -G` resolved. */
  user?: string;
  /** Every other name the SSH config gives the same server. */
  aliases: string[];
  /** The sites whose site file names this server as their host. */
  sites: string[];
  /** Where the server was found. */
  source: "ssh_config" | "site_file";
}

export interface SiteAsset {
  kind: "site";
  /** The site's name: its site file's name. */
  name: string;
  /** The site's home address. */
  url: string;
  /** The platform the site file names, such as `wordpress`. */
  platform?: string;
  tier?: string;
  /** How the site's server is reached, from the site file's `host` block. */
  server?: SiteServer;
}

export type Asset = ServerAsset | SiteAsset;

/** The name an asset goes by in a report: `server:zysys`, `site:isjac`. */
export const assetLabel = (asset: Pick<Asset, "kind" | "name">): string => `${asset.kind}:${asset.name}`;
