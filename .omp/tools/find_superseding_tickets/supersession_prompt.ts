import { NO_RECURSION } from "./omp_session.js";

/** The supersession question, copied from the Mastra capability's `find_superseding_tickets.yaml` and adapted to a full omp session that answers in JSON. */
export function supersessionPrompt(ticket: string): string {
  return `Find which Linear tickets, filed after Linear ticket ${ticket} was filed, supersede it. This is a read-only check. Do not
edit any ticket, comment, or change a status. Linear tools are not preloaded: find them with tool_search.

1. Read ${ticket} (body, every comment, related issues, labels, project) and note the moment it was filed (its createdAt).
2. Search Linear for tickets filed after that moment, in every status including Done, Canceled and Duplicate, and in
   this ticket's team, project and any team its related issues or body point at. Search by the ticket's own terms,
   not only its labels. Open each plausible hit and read it.
3. A ticket supersedes ${ticket} when finishing it makes ${ticket}'s whole ask unnecessary: it covers all of the same
   scope, replaces the approach, or removes the thing ${ticket} was about. A ticket that overlaps part of the ask, shares a
   theme, or is a sibling does not supersede it. A newer ticket that was itself canceled does not supersede it either,
   unless its cancellation says the work moved elsewhere.

Report:
- filed_at: when ${ticket} was filed, as the ISO 8601 timestamp Linear gives.
- superseded_by: each ticket that supersedes it, with its identifier, its own filed_at timestamp, and why in one sentence.
  Empty when none does.
- evidence: one or two sentences naming what you searched and what ruled the near misses out.

${NO_RECURSION}

## Your answer

Reply with ONLY one JSON object: no prose, no code fence. Its shape:
{"filed_at": "<ISO 8601>", "superseded_by": [{"id": "<identifier>", "filed_at": "<ISO 8601>", "why": "<one sentence>"}], "evidence": "<what was searched and what ruled out the near misses>"}
Every field is required and every string non-empty; superseded_by may be [].

Examples:
- Linear ticket ZYS-10 asks for a retry wrapper. ZYS-14, filed later, moves the whole client onto a library that retries by itself.
  {"filed_at":"2026-09-01T10:00:00.000Z","superseded_by":[{"id":"ZYS-14","filed_at":"2026-09-20T08:30:00.000Z","why":"Adopting the library gives the client built-in retries, so a hand-written wrapper is moot."}],"evidence":"Searched the team's tickets after 2026-09-01 for retry, backoff and client; ZYS-12 only adds logging and does not cover it."}
- Linear ticket ZYS-20 asks for a CSV export. Newer tickets mention exports but only for PDF.
  {"filed_at":"2026-10-02T12:00:00.000Z","superseded_by":[],"evidence":"Searched for export and CSV since 2026-10-02; the only hits are the PDF export, a different format."}`;
}
