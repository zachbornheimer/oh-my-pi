const DEPENDENCY_BOTS = ["dependabot", "renovate"] as const;

/** True for Dependabot and Renovate, including `app/` and `[bot]` login forms. */
export function isDependencyBotLogin(login: string): boolean {
  const author = login.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
  return DEPENDENCY_BOTS.some(
    (bot) => author === bot || author.endsWith(`-${bot}`) || author.endsWith(`-${bot}-bot`),
  );
}
