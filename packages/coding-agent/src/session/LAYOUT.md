# Turn recovery ownership

- `turn-recovery.ts`: public recovery operations and composition of narrow recovery owners.
- `recovery-eligibility.ts`: replay admission from explicit transcript and lifecycle observations.
- `recovery-replay.ts`: pure transcript-tail and tool replay decisions.
- `recovery-context.ts`: active transcript removal and safe manual continuation.
- `recovery-history.ts`: durable failed-turn removal and compaction rollback through SessionManager.
- `recovery-errors.ts`: persisted retry-attempt annotations.
- `recovery-saga.ts`: retry promise, attempt budget, cancellation, and terminal lifecycle.
- `recovery-terminal.ts`: bounded empty-stop recovery.
- `recovery-stop.ts`: unexpected-stop judgment and continuation.
- `recovery-reminders.ts`: bounded corrective continuation and retry reminders.
- `recovery-attribution.ts`: session-anchored serving attribution and reasoning replay state.
- `recovery-chains.ts`: configured chain resolution, discovery validation, and offline candidate ordering.
- `recovery-candidates.ts`: request-specific fallback admission, including frozen side-request context.
- `recovery-selection.ts`: fallback ownership, restoration, and model-transition coordination.
- `recovery-usage.ts`: usage preflight approval and keyed candidate selection.
- `recovery-credentials.ts`: credential-limit bookkeeping, account rotation, and reset recovery.
- `recovery-policy.ts`: pure retry pacing, refusal strategy, and final disposition decisions.
- `recovery-attempt.ts`: observe retry facts, decide routing, execute a bounded retry attempt.
- `model-controls.ts`: model mutation, effort application, model history, and prompt reconciliation.

The composition root distributes capabilities; no execution owner receives the aggregate construction input. SessionMaintenance owns context-fit and compaction. ModelRegistry/authStorage owns credential pools. SessionManager owns durable branches. AgentSession remains the provider-session mutation authority used by ModelControls. Side requests use the same chain admission and credential owner without model or history mutation.
