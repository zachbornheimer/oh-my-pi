/** One Linear workspace a security sweep files into, and what the sweep needs of it. */
export type Workspace = {
  /** The Linear team key tickets are named by, such as SAH in SAH-123. */
  team: string;
  /** The environment variable holding this workspace's Linear API key; `LINEAR_API_KEY` is the fallback. */
  apiKeyEnv: string;
  /** The GitHub organisations the workspace's repositories live in. */
  orgs: readonly string[];
  /** The statuses a sweep files into (the first) and settles to (`done`), by name. */
  inputs: readonly string[];
  done: string;
  /** The workspace a GitHub owner routes to when no workspace lists that owner in `orgs`. Exactly one entry carries this. */
  fallbackForOwners?: true;
};

/** SAH has a Triage status; ZYS does not and takes `Unreviewed`. */
export const WORKSPACES: readonly Workspace[] = [
  {
    team: "SAH",
    apiKeyEnv: "LINEAR_API_KEY_SAH",
    orgs: ["Software-Automation-Holdings-LLC"],
    inputs: ["Triage", "Unreviewed", "Ready for Dev"],
    done: "Done",
  },
  {
    team: "ZYS",
    apiKeyEnv: "LINEAR_API_KEY_ZYS",
    orgs: ["zachbornheimer"],
    inputs: ["Unreviewed", "Ready for Development"],
    done: "Done",
    fallbackForOwners: true,
  },
];

/**
 * The Linear workspace a GitHub owner routes to: the workspace that lists the owner in its `orgs`, else the one entry
 * marked `fallbackForOwners`.
 */
export function workspaceForOwner(owner: string, table: readonly Workspace[] = WORKSPACES): Workspace {
  const holder = table.find((workspace) => workspace.orgs.includes(owner));
  if (holder !== undefined) return holder;
  const fallbacks = table.filter((workspace) => workspace.fallbackForOwners === true);
  if (fallbacks.length !== 1) {
    throw new Error(
      `no workspace lists GitHub owner "${owner}" and ${fallbacks.length} workspaces claim the fallback; exactly one entry must carry fallbackForOwners`,
    );
  }
  return fallbacks[0]!;
}
