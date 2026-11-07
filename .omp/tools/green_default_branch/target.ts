import type { RepositoryFilter } from "./workflow.js";

export type Target = { kind: "repository"; nameWithOwner: string } | { kind: "sweep"; filter: RepositoryFilter };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `all`, an owner login, `owner/name`, or `https://github.com/owner/name`. A pull request URL is refused: pull request
 * work belongs to `make_pr_mergable`.
 */
export function parseTarget(raw: string): Target {
  const text = raw.trim();
  if (text === "") throw new Error("target is empty: give `all`, an owner, `owner/name` or a repository URL");
  if (text.toLowerCase() === "all") return { kind: "sweep", filter: { kind: "all" } };
  const url = text.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?(\/.*)?$/);
  if (url !== null) {
    if (url[3] !== undefined && url[3] !== "") {
      throw new Error(`${text} is not a repository URL: pull request work belongs to make_pr_mergable`);
    }
    return repository(url[1] as string, url[2] as string, text);
  }
  const parts = text.split("/");
  if (parts.length === 2) return repository(parts[0] as string, parts[1] as string, text);
  if (parts.length === 1 && OWNER.test(text)) return { kind: "sweep", filter: { kind: "owner", owner: text } };
  throw new Error(`target ${text} is not \`all\`, an owner, \`owner/name\` or https://github.com/owner/name`);
}

function repository(owner: string, name: string, text: string): Target {
  if (!OWNER.test(owner) || !REPO_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`target ${text} is not a valid owner/name`);
  }
  return { kind: "repository", nameWithOwner: `${owner}/${name}` };
}
