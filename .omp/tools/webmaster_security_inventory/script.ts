/**
 * The shell pieces a WP-CLI command line over SSH is built from. Copied from the webmaster-site package's
 * `platform/wordpress/script.ts` (only the three pieces the inspection uses).
 */

/** A function, not a variable: a function body is parsed, so the quoted --path survives. */
export const WP_FUNCTION = "webmaster_wp";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WordPressHost {
  readonly wpRoot: string;
  /** Command prefix that runs wp-cli on the host; may name a PHP binary or switch user. */
  readonly wpCli: string;
}

/**
 * WP Engine's wp wrapper finds the site from the working directory and rejects --path from
 * elsewhere; on Plesk the login user cannot enter the docroot, so --path is the only way in.
 */
export function hostPreamble(host: WordPressHost): string[] {
  const root = shellQuote(host.wpRoot);
  return [
    "set -u",
    `${WP_FUNCTION}() ( if cd ${root} 2>/dev/null; then ${host.wpCli} "$@"; else ${host.wpCli} --path=${root} "$@"; fi )`,
  ];
}
