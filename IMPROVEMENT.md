# Improvement: Open shared-store resume sessions without scanning every transcript

## Intent

Make the installed `omp --resume` picker visibly ready within a hard 30-second PTY deadline, preserving shared-only sessions and existing scope/filter behavior.

## Evidence

- Installed release `build-20261122225547-8829553-041ccf8` and a replay of its 18 carried topics both failed to render `Resume Session` within the 28-second observation window (hard outer deadline 30 seconds). Startup remained in `SessionManager.listForPicker`.
- Upstream-only source and compiled controls were fast because they used file storage; the fork's CLI explicitly supplies `resolveSessionStorage()` and therefore SQL storage. Bun 1.4.4 versus 1.4.5 and the release native addon were ruled out independently.
- Shared SQL initialization took 2107.54 ms. The current folder had 1183 shared rows, 226 with indexed titles. The picker then issued 247 per-file slice/line/assistant-turn reads before its 30-second diagnostic deadline; individual reads commonly took 130–700 ms, with some exceeding 5 seconds.
- The real SQLite SQL regression failed before the production change: expected one batched prefix call before blocked full scans, observed zero.

## Contract and ownership

`session-listing.ts` owns picker projection: titled indexed-storage rows use existing backend title/stat metadata and the existing batched header reader, then the unchanged full scan completes asynchronously. Shared-only paths never require a disk stat or realpath. All-project enumeration uses the storage's bucket listing. Header properties remain intact for assembly-owned foreign-session filtering; current-folder sibling directories, pinned empties, untitled completion, and explicit resume loading retain their existing owners.

## Pattern inventory

- One file-only fast-path decision in `pickerListing` excluded shared SQL storage; extended at the same owner.
- One disk-only global enumeration/deduplication path lost shared-only rows; backend enumeration and local-only realpath deduplication now distinguish their actual filesystem requirements.
- Existing batched prefix policy, title normalization, stat identity, full scan, and picker filtering are reused rather than duplicated.
