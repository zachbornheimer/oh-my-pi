# Improvement: prove exhausted model recovery and repair role coverage

## Intent

“Models are supposed to be falling back”: preserve the selected model as a preference, advance its configured chain on route failures, and keep cancellation terminal.

## Observations

- The at-0hgvsm worker launched with `--model @task` and the pin-model overlay. Its print log recorded Grok HTTP 403 `personal-team-blocked:spending-limit` once.
- Supported transcript export `omp:01a20e81-88da-7285-965d-0fb3ca77fc99` contains 38 usage-bearing turns on `openai-codex/gpt-6.1-sol`, from Unix timestamp 1795539725.243 to 1795540565.16. Thus fallback had succeeded; a quiet print log did not establish a stalled model route. No retry-engine change is justified by this incident.
- Live `retry.fallbackChains.design` repeated only its primary. `judge` contained `@tiny` and `@smol`, both resolving to the same Grok model. Explicit chains supersede default inheritance. These were genuine configuration coverage defects, not classifier defects.
- A separate installed CLI regression changed only the primary assignment from `task: loopback/primary` to `task: @memory`, `memory: loopback/primary`. The same configured task chain then failed HTTP 403 with exit 1 and empty stdout rather than recovering. Runtime chain construction parsed raw `@memory` as a concrete selector, obtained no primary, and returned no candidates. This confirms a real alias-backed fallback defect independently of the historical worker.

## Ownership and contract

The existing shared classifier owns credit/budget classification; session recovery owns traversal, replay safety, and exhaustion. User YAML owns role-specific order. Preserve all role primaries, advisor separation, retry policy, and the pin overlay. Expand design with the existing default suffix and judge with the existing tiny chain. Do not append default chains globally or change cancellation semantics.

The new native Bun test launches either source CLI or `OMP_TEST_BINARY` under isolated HOME with loopback HTTP providers. It records actual model requests, compares complete request messages across fallback, requires the completion token and exit status, checks finite exhaustion and abort rejection, and optionally validates distinct routes for every configured role through `OMP_FALLBACK_CONFIG`.

## Evidence

Before YAML repair, the installed CLI already recovered both HTTP 403 Grok credit and HTTP 422 budget failures via `loopback/primary -> loopback/fallback`, preserving request messages and returning exit 0. Both-denied routes terminated with exit 1. The coverage assertion failed with `error: design`, `Expected: > 1`, `Received: 1` (3 pass, 1 fail).

After the atomic YAML edit, the installed proof reports `5 pass`, `0 fail`, `33 expect() calls` in 10.05 seconds: credit and budget failures recover with exit 0, actual RPC user cancellation requests only primary and exits 0, both exhausted models terminate with exit 1, and all configured roles have distinct fallback identities. The tested executable is `/Users/zbornheimer/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-20261124171500-8829553-resumefix/omp`.
Run the focused installed proof from this worktree:

```sh
OMP_TEST_BINARY="$(mise where github:zachbornheimer/oh-my-pi)/omp" \
OMP_FALLBACK_CONFIG="$HOME/.omp/agent/config.yml" \
bun test packages/coding-agent/test/cli-credit-fallback.test.ts
```

The shared fallback chain constructor now calls the existing `resolveConfiguredModelPatterns` owner for role primaries and entries, retaining nested alias expansion, outer effort precedence, and bounded cycle handling. No classifier, role-order, advisor separation, or retry policy is replaced. Focused selector and real CLI tests cover the changed path; the repaired source must be shipped through fork/mise before claiming installed alias recovery.

The existing configured-pattern expander deliberately layers effort suffixes; `parseModelString` now consumes every recognized layer with the outermost effort authoritative, retaining literal `:max`/`:auto` lookup guards. Source proof: 33 focused fallback/CLI tests pass (108 assertions); 15 shared model-string parser tests pass (29 assertions); coding-agent typecheck passes across 5,822 files. The CLI fixture passes the scanner with zero findings and uses a fixed executable argv launcher without a shell.
