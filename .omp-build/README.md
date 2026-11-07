# omp-build: the carry on `main`

`zachbornheimer/oh-my-pi` is a fork of `can1357/oh-my-pi`. Its `main` is
upstream `main` plus **one carry commit**: the build machinery, and nothing
else. Everything the carry adds lives under `.omp-build/`, a directory upstream
does not have, so syncing from upstream never conflicts there. The one
unavoidable exception is `.github/workflows/omp-build.yml`, which GitHub
requires in that directory (and on the default branch, for the hourly
schedule).

| Path                              | What it is                                                    |
| --------------------------------- | ------------------------------------------------------------- |
| `.github/workflows/omp-build.yml` | The build: assemble, build darwin-arm64 + linux-x64, publish. |
| `.omp-build/resolve-branches.ts`  | Reads `branches/` and prints the ordered branch list.         |
| `.omp-build/branches/**/*.toml`   | One file per carried branch (the manifest).                   |
| `.omp-build/README.md`            | This file.                                                    |

Why this shape (carry on `main`, one file per branch, tools kept out of the
fork) and how to keep a fork cheap: the `forking-projects` skill,
`~/.agents/skills/forking-projects/SKILL.md`, and its
`references/branch-manifest.md`. The live procedures for this fork are in the
`updating-oh-my-pi` skill.

## How a build works

`omp-build` runs on every push to `main` (a base change or a manifest change),
every 15 minutes (to pick up pushes to carried branches, which cannot trigger
it), and on `workflow_dispatch`. It:

1. checks out the triggering commit (`main`'s tip for a push or the schedule; the
   dispatched ref's tip for a manual run) as the **base**;
2. runs `bun .omp-build/resolve-branches.ts` to get the ordered branch list;
3. fetches each branch from the fork and merges it onto the base with
   `git merge --no-ff`, in order;
4. skips build and publish when the assembled tree equals the tree of the
   latest release's recorded `build_commit`;
5. otherwise pushes the result to the throwaway `omp-build` branch, builds both
   binaries, and publishes release `build-<timestamp>-<upstream7>-<build7>` as
   Latest. `<upstream7>` is the newest `can1357/oh-my-pi` commit the base
   contains; `<build7>` is the assembled commit. The release body also records
   `base_commit` (the carry tip).

It fails, and the previous release stays Latest, when a listed branch is missing
from the fork, or conflicts with the base or an earlier branch. Each failure
opens or updates one `omp-rebuild`-labelled issue naming the branch. A branch
that is already an ancestor of `can1357/oh-my-pi:main` only warns
(`merged upstream, delete this file`).

A `workflow_dispatch` with a non-empty `branches_override` (comma-separated)
builds exactly that list and publishes a **prerelease**, never Latest.

## Branch files

The path under `branches/`, minus `.toml`, is the branch name:
`branches/fix/native-build-cargo.toml` is branch `fix/native-build-cargo`.
There is no `branch` field, so a file and its branch cannot drift.

```toml
reason = "build:native finds cargo without setup, and names what to install if it is missing."
upstream = "candidate" # no | candidate | submitted | merged
pr = "" # required when upstream = "submitted"
layer = 50 # merge order, lower first; default 50
```

| Field      | Required          | Meaning                                                                                                                                                                |
| ---------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`   | yes               | Plain English: what the branch does for the person running the build.                                                                                                  |
| `upstream` | no (default `no`) | `no` personal, never submitted; `candidate` suitable for an upstream PR, not yet sent; `submitted` PR open; `merged` upstream has it, so delete the file.              |
| `pr`       | when `submitted`  | Upstream PR number or URL.                                                                                                                                             |
| `layer`    | no (default `50`) | Integer merge order, lower first. Ties break by file path. Use a low layer for a base that others depend on (`steering-fixes` is `10`: it already contains the stack). |

The resolver orders by `(layer, path)` and fails the run, naming the file, on a
missing `reason`, an unknown key, a bad `upstream`, `submitted` without `pr`, a
non-integer `layer`, an unusable branch name, or a duplicate.

### Add a branch

1. Push the branch to the fork (`git push fork <branch>`). A listed branch that
   is not on the fork fails the whole assembly.
2. Create `.omp-build/branches/<branch>.toml` with at least `reason`.
3. Dry-run: `bun .omp-build/resolve-branches.ts "" schedule` prints the resolved
   list, one branch per line.

Nothing else changes, so two people adding different branches never touch the
same file; adding the same branch twice is the same path, which git reports as
a conflict. That is the correct collision.

### Remove a branch

Delete its file. Do this when upstream merges it (`upstream = "merged"`, or the
workflow prints `merged upstream, delete this file`) or when it is abandoned.

### What does not belong here

Per-tool branches (`tools/*`) are not carried: custom tools are discovered from
`~/.omp/agent/tools` and `.omp/tools`, so they need no fork. A generator that
wants to register dozens of near-identical branches should write files into a
tools directory instead.

## Keeping `main` current

`main` is upstream plus the carry commit. To take new upstream commits, merge
`can1357/oh-my-pi:main` into `main`; the carry lives only under `.omp-build/` and
the one workflow file, so it does not conflict. Never force-push `main` or any
branch listed here. Upstream's own workflows in `.github/workflows/` come back
with every sync: disable them in the fork's Actions settings.
