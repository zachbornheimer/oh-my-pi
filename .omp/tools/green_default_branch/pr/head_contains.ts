import { obj, parseJson, str } from "./decode.js";
import type { GitHubPorts } from "./ports.js";

/**
 * Whether GitHub's `head` of the pull request contains the commit the host pushed: it is that commit, or a bot (a CI
 * gate, a formatter) has committed on top of it. Either way the push landed and the head is the one to judge. A head
 * that does not descend from the push, or a compare GitHub cannot answer yet, is not it.
 */
export async function headContains(
  ports: Pick<GitHubPorts, "gh">,
  repo: string,
  pushed: string,
  head: string,
): Promise<boolean> {
  if (head === pushed) return true;
  try {
    const answer = obj(parseJson(await ports.gh(["api", `repos/${repo}/compare/${pushed}...${head}`]), "compare"), "compare");
    const status = str(answer.status, "compare status");
    return status === "ahead" || status === "identical";
  } catch {
    return false;
  }
}
