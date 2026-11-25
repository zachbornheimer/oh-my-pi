# Verifying the native addon of a promoted fork release

How to prove that a fork release's own native addon passes the tests that exercise
it, on the exact assembly commit the release was built from. The addon is embedded
inside the compiled `omp` binary, so "which addon ran" is only answered by
extracting it back out of that binary.

## When to use this

After the fork's release workflow promotes a tag (job `Promote to latest`) and you
need to show the promoted binary's addon still passes the tests — for example to
close out a release-verification ticket that must not repeat the release run.

## Procedure

1. **Pin the tag.** A bare `mise exec github:<owner>/oh-my-pi` installs whatever is
   Latest *now*, which is usually a later build. Always name the version:

   ```
   V=github:zachbornheimer/oh-my-pi@20261125104043-e1a9f4b-2937770
   mise exec "$V" -- omp --version   # must name this tag
   mise exec "$V" -- omp --help
   mise exec "$V" -- omp --smoke-test
   ```

2. **Extract the embedded addon into a scratch dir.** `PI_NATIVES_DIR` moves the
   versioned natives dir, so a fresh directory forces extraction instead of
   reusing (and mis-hashing) what is already on the host. The loader only compares
   *size* when deciding whether an existing file is current, so a shared directory
   can silently hand you the hash of an older addon:

   ```
   rm -rf /tmp/<scratch>; mkdir -p /tmp/<scratch>
   PI_NATIVES_DIR=/tmp/<scratch> mise exec "$V" -- omp --smoke-test   # exit 0
   sha256sum /tmp/<scratch>/19.1.0/pi_natives.linux-x64-modern.node
   ```

3. **Check out the assembly commit** the release was built from (the release's
   `fork-plan.json` asset names `head` and `tree`; the tag's own suffix is the
   head's short SHA). Create the worktree with `wt`, then install:

   ```
   wt switch -c <branch> -b <assembly-sha>
   cd <worktree> && bun install --frozen-lockfile
   git rev-parse HEAD HEAD^{tree}   # HEAD = assembly-sha, tree = fork-plan tree
   ```

4. **Put the extracted addon where the workspace loader looks.** In a non-compiled
   (workspace) run the loader reads `<repo>/packages/natives/native/<addon>.node`
   (the `PI_NATIVES_DIR` override only applies to compiled binaries). `*.node`
   is gitignored, so this is an untracked build input:

   ```
   cp /tmp/<scratch>/19.1.0/pi_natives.linux-x64-modern.node <worktree>/packages/natives/native/
   ```

5. **Run the tests on that assembly** and record pass/fail/assertion counts.

## Recorded result — tag `build-20261125104043-e1a9f4b-2937770` (2026-11-25)

* `omp --version` → `omp/19.1.0` / `build-20261125104043-e1a9f4b-2937770`, exit 0.
* `omp --help` → `omp v19.1.0`, exit 0.
* `omp --smoke-test` → `smoke-test: ok`, exit 0 (plain, and again with a scratch
  `PI_NATIVES_DIR`).
* Extracted addon: `19.1.0/pi_natives.linux-x64-modern.node`, 185,459,320 bytes,
  SHA256 `beaad880d50c98b6a8a466496cd5b528460dc9773f751664f81f9b3b9c10a400`.
  This is **byte-identical to the interim addon** from the earlier
  `build-20261125094236-e1a9f4b-f8db1d6` build: the four inventory test files
  exercise TypeScript-side behaviour, and the native addon did not change between
  those two builds.
* Worktree at `HEAD 29377703100d302b38d70a20137d5574838332e9`,
  `tree c55987f75c758b7311d764c9d55a452320ed1ee1`, after
  `bun install --frozen-lockfile`.
* Four-file run — `system-prompt-inventory.test.ts`, `tool-command-host.test.ts`,
  `bash-tool-commands.test.ts`, `tools/tool-command-docs-none.test.ts`:
  **64 pass, 0 fail, 215 expect() calls, 4 files**, exit 0.
