import type { MergeReport, Landing } from "./schemas.js";
import { LANDING_ROUTES } from "./schemas.js";
import type { UpgradeReport } from "./ports.js";

/**
 * Where a pull request stands once its landing capability has answered. `merged` and `queued` (a merge queue, or automerge,
 * holds it open and merges it) are landed; every other state is the capability's own word for why the pull request is still
 * open, or `error` when the capability itself could not answer.
 */
export const LANDED_STATES: readonly string[] = ["merged", "queued"];

/** What a landing needs: who opened the pull request, and the two capabilities that can land one. */
export type LandingPorts = {
  /** The login of the pull request's author, as GitHub names it (`app/renovate`, `dependabot[bot]`, `octocat`). */
  readPullRequestAuthor(url: string): Promise<string>;
  makePrMergable(input: { prUrl: string; merge: boolean }): Promise<MergeReport>;
  upgradeDependency(input: { prUrl: string }): Promise<UpgradeReport>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const DEPENDENCY_BOTS = ["dependabot", "renovate"] as const;

/** True for Dependabot and Renovate, including `app/` and `[bot]` login forms. */
export function isDependencyBotLogin(login: string): boolean {
  const author = login.toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
  return DEPENDENCY_BOTS.some((bot) => author === bot || author.endsWith(`-${bot}`) || author.endsWith(`-${bot}-bot`));
}

/** The route a pull request's author picks: a dependency bot's pull request is upgraded, never put through the merge path. */
export function routeFor(authorLogin: string): (typeof LANDING_ROUTES)[number] {
  return isDependencyBotLogin(authorLogin) ? "upgrade_dependency" : "make_pr_mergable";
}

/**
 * REMOTE (GitHub): lands one pull request through the capability its author's kind names and answers where it stands. An
 * `upgrade_dependency` `ready` is `queued`: the capability arms automerge and never merges itself. Nothing here throws: a
 * capability that cannot answer is `error`, not landed, with its message as the reason, so the caller can name the gap.
 */
export async function landPullRequest(ports: LandingPorts, url: string, options: { merge: boolean }): Promise<Landing> {
  let route: Landing["route"] = "make_pr_mergable";
  try {
    // Without the caller's opt-in nothing merges, and `upgrade_dependency` arms automerge: the pull request is only driven
    // to settled approved, and reported not landed.
    if (!options.merge) {
      const report = await ports.makePrMergable({ prUrl: url, merge: false });
      return { url, route, state: report.status, landed: false, reasons: report.reasons };
    }
    route = routeFor(await ports.readPullRequestAuthor(url));
    if (route === "upgrade_dependency") {
      const report = await ports.upgradeDependency({ prUrl: url });
      const state = report.verdict === "ready" ? "queued" : report.verdict;
      return { url, route, state, landed: LANDED_STATES.includes(state), reasons: report.reasons };
    }
    const report = await ports.makePrMergable({ prUrl: url, merge: true });
    return { url, route, state: report.status, landed: LANDED_STATES.includes(report.status), reasons: report.reasons };
  } catch (error) {
    return { url, route, state: "error", landed: false, reasons: [message(error)] };
  }
}

/** One line a ticket comment or a settling report carries for a landing: the url and where it stands, with the gap named when it is not landed. */
export function landingLine(landing: Landing): string {
  return landing.landed
    ? `pull request ${landing.url} landed (${landing.state}, via ${landing.route})`
    : `pull request ${landing.url} NOT landed: ${landing.state} (via ${landing.route}); the ticket is not done`;
}
