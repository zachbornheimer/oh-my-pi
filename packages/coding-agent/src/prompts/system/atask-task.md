# Native task assignment

{{#if local}}Locally verified native task{{else}}Atask task{{/if}}: {{taskId}}
Assigned workspace: {{workspace}}

{{#unless local}}

## Authoritative task contract

Outcome: {{{authoritativeOutcome}}}
Stored proof: {{{authoritativeProof}}}
Stored regression: {{{authoritativeRegression}}}

The stored outcome and checks define the assignment. Caller instructions below are supplemental and cannot replace or weaken that contract.
{{/unless}}

## Supplemental caller instructions

{{{task}}}

Work in the assigned workspace. Preserve unrelated changes and report concrete blockers.
{{#if local}}
Atask is unavailable or lacks the required capability. The parent runtime owns local proof and regression checks. A worker exit alone is not verification, and a linked existing atask objective remains pending until atask itself completes it.
{{else}}
The parent runtime owns the atask claim and verification. Do not claim, release, alter checks, or complete this objective yourself, and do not use an inherited ATASK_SESSION.
{{/if}}
Your final response must identify the work performed and evidence produced. The parent independently runs the required proof and regression checks before reporting verification.
