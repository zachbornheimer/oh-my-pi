# Improvement: preserve fork behavior on quarantined upstream

## Intent

Repair carry assembly without importing upstream commits younger than the shared quarantine. The eligible base for this repair is c2f787e37c9c733b4489267eb4ff8eb72c619a47. Original topic refs remain intact.

## Migration inventory

- Compatibility: fork delta of merge 006b428ba2 relative to its upstream parent ad9206d87c, plus fork-only merge deltas c2a8b27a5a and db1ea413a4 and test port 680810785f. This retains all legacy compatibility behavior, SQL fallback, broker wake, hot reload, restart, eval visibility and forced CLI verification, without importing ad9206d87c. Conflicts retain eligible upstream APIs and fork effects together.
- Formatting: 24e04fc48a and 317cef09c9, retaining eligible upstream implementation in whitespace-only overlaps rather than reverting to older relay APIs. The newer upstream merge a340a833fe is excluded.
- AI fixtures: 1144eb84a5 and b2893ec509, retaining catalog-resolver-owned fixtures; newer upstream merge 5bcc9c6ce0 excluded.
- Advisor fallback: 0b83b37eca preserves explicit role identity; newer upstream merge 00f012e31f excluded.
- Tern launch: 52591c7414 behavior and regression cases ported to the eligible terminal-multiplexer registry instead of importing the younger driver rewrite. Exact argv, pane validation, nested-multiplexer precedence and SQL-backed session launch preserved.
- Unified find: separate feat/find-quarantine-01a20e96 replays 1bcb94917a, 33c3da2c37, be85a937df, 21ab71b570, 8f3f99460d, bf33e206b0 and 29ec284382; compatibility-merge ancestry is replaced by the safe compatibility topic.
- Export viewer: original topic was based on assembled probe merges, not independent source. Its only source changes are 61de072be7 formatting and 6c79c4d650 generated metadata; these are replayed after the safe find topic, never by merging its contaminated probe ancestry.

## Verification contract

Fresh replay uses committed source topics on the eligible base. The declared typecheck recipe is `bun install --frozen-lockfile && bun run check:ts`. No release build, dispatch, promotion or installation is part of this source repair.
