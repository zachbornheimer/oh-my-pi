import { hostPreamble, shellQuote, WP_FUNCTION } from "./script.ts";
import type { SiteServer } from "./site_context.ts";

/** SSH options every read uses: no prompt, a 15 s connect. */
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"] as const;
/** A word a site file may contribute to a command: no spaces, quotes, `;`, `|`, `&`, `$`, backticks or redirects. */
export const PLAIN_WORD = /^[A-Za-z0-9_./@:=+-]+$/;
export const SSH_FAILED = 255;

export function plainWords(value: string, field: string): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const unsafe = words.find((word) => !PLAIN_WORD.test(word));
  if (unsafe !== undefined) throw new Error(`the site file's host.${field} has "${unsafe}", which is not a plain word`);
  return words;
}

/** The commands each site file's values are put into: WP-CLI as the site user. */
export function commandBuilders(server: SiteServer) {
  const wp = plainWords(server.wp_cli ?? "wp", "wp_cli");
  const [root] = plainWords(server.wp_root, "wp_root");
  if (root === undefined) throw new Error("the site file's host.wp_root is empty");
  // The construction `webmaster wp` proved on WP Engine and Plesk: `cd <wp_root>` when the login user can (WP Engine's
  // wrapper finds the site from the working directory and rejects --path), `--path` otherwise. wp_root may be relative.
  const preamble = hostPreamble({ wpRoot: root, wpCli: wp.join(" ") }).join("; ");
  const word = (value: string) => (PLAIN_WORD.test(value) ? value : shellQuote(value));
  return {
    /** WP-CLI with plugins and themes left unloaded: nothing a site adds runs. */
    wpCli: (...args: string[]) => `${preamble}; ${WP_FUNCTION} ${["--skip-plugins", "--skip-themes", ...args].map(word).join(" ")}`,
  };
}
