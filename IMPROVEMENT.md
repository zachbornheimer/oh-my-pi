# Improvement: Keep native atask carry within upstream quarantine

## Intent

Rebase the two native atask commits onto the fork's published quarantine-eligible upstream base without changing the quarantine policy.

## Evidence and compatibility

- Previous base: `26702495a57ba8f0161a99ec34a370cba014dedc`; release run `45460599717` rejected its young ancestry.
- Eligible base: `b3142bf7e7e459560919abec0658b5f3851bcbcc`, recorded by successful run `45459937259` and release `build-20261124183143-b3142bf-4556921` in `fork-plan.json`.
- Preserve native dispatch, parent-memory checks, durable atask verification, and restore routing. Apply task contract additions to this base's existing `packages/tui/src/tools/task.ts` owner; do not recreate the later coding-agent task-details module or import later renderer APIs.
- Preserve this base's extension rendering contracts and batch-input behavior rather than importing unrelated newer upstream changes.

## Verification

The three requested native atask test files passed: 30 tests, 138 assertions, zero failures, using Bun 1.4.5. The native loader warned that the existing binary is 19.1.1 while this eligible checkout is 19.1.0; assembled-release checks and installed-binary proof remain the release owner's responsibility.

## Outcome

The carry no longer needs young upstream ancestry. The separate fork-tool defect—creating topics from the mirror tip rather than the quarantine-selected base—is outside this native carry's scope and must be fixed by its owner.
