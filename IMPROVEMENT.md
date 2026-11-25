# Improvement: Retain account-specific broker reauthentication notices

## Intent

Keep automatically signed-out OAuth accounts visible until that account/subscription returns, without interrupting healthy fallback or changing refresh policy.

## Ownership and inventory

- Existing transient warning: `credential-disabled-notice.ts` formats and now owns the unresolved account set; `sdk.ts` composes it once. The previous event-only warning could not discover startup/offline failures.
- Existing notice transport: session `notice` events now optionally carry `persistentKey`; the session retains those notices for late subscribers. Empty message removes one key. No notice enters model context or stored conversation history.
- Existing terminal consumer: `EventController` replaces/removes account-keyed warning rows in an editor-anchored container, present in both terminal and native dock layouts. Status clearing, transcript rebuilding, and turn-start error dismissal do not own this container.
- Existing broker observations: full snapshots (including unchanged reconnects), entry and removal deltas notify credential generation subscribers. Tombstones obey the same configured broker account pool as active credentials.
- Identity: reuse `resolveCredentialIdentityKey`, including org-scoped provider behavior. Latest tombstone wins; deliberate replacement/logout, API keys, identity-less rows, already-active identities and non-login providers do not create reminders.

## Contract and safety

Startup, credential generation, broker reconnect and automatic disable converge on one coalesced reconciliation owner. Five-second bounded reads are generation-fenced; an outage or stale result cannot dismiss a reminder. Disposal unsubscribes and rejects late results. Only an active matching OAuth identity clears an existing account reminder. Broker-backed `/login` already uploads through the authoritative store; its generation change invokes reconciliation. No refresh algorithm, gateway error shape or live credential is changed.

## Proof surfaces

- `mise run test:reauth-notice`: broker→credential pool→notice owner→TUI rows, full SDK warning bridge and late mode replay.
- `mise run test:reauth-regression`: focused broker snapshot/login/local-provider and terminal/print warning regressions.
- `REAUTH_PROOF_OUTPUT=/tmp/reauth-terminal.txt mise run proof:reauth-tui`: actual InteractiveMode/Composer on kitty's WASM terminal engine, throwaway loopback broker DB, startup reminders, transcript overflow, resize, healthy fallback, `/login` selector controller and account-specific clear. All credentials are synthetic; state is removed on exit. Captured viewport evidence is optional and contains only fixture addresses.

## Build and installation boundary

Local prerequisites: `bun install --frozen-lockfile`, then `bun scripts/bazel-natives.ts host` (matching checkout native addon). Standard fork build runs `bun run check:ts`, then `PI_BUILD_IDENTITY="$FORK_TAG" bun --cwd=packages/coding-agent run build`. Parent owns supported `fork land`/promotion and mise installation; source fixture success is not installed-artifact proof. Never merge this topic into the pristine upstream mirror or hand-copy a CLI binary.

## Evidence

The first named proof attempt exposed a missing native addon. A temporary older native artifact exposed the intended public notice-shape change and a missing native symbol; a matching native build was then requested. Final command outcomes are reported in the worker handoff, not inferred from this record.
