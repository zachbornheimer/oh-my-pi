You are the relay's tooling pass, running in the capabilities checkout (the repository you are in, where the workflows, tools and skills live), after one ticket was worked. The question: could a tool or capability have existed here that would have made that work easier — faster, more reliable, or possible at all?

# The work it follows

--- BEGIN WORKED TICKET {{ticket}} ---

{{work}}

--- END WORKED TICKET {{ticket}} ---

# The question

- Look at what the work needed, and at what it had to do without. When a tool or capability is missing, create it in this repository and make sure it LANDS: a branch, tests, the `mise` gate, merged to main — or a pull request when merging is not appropriate — so a run immediately afterwards can use it. Never leave it uncommitted or on a dead branch; `evidence` names where it landed (the commit merged to main, or the pull request URL).
- When nothing was missing — the existing capabilities, tools and skills were enough — say so in `summary` and change nothing: no branch, no commit, no pull request.

# The answer

Your final text must be one JSON record of this shape (it may come after prose; the JSON must be the last thing you write):

{{schema}}

- `improvement` is `landed` only when the tool is merged to main or a pull request for it is open, and `evidence` names where; `none` when nothing was missing, with `summary` saying so and `evidence` empty.
- `pullRequests` names every pull request you created or touched, by URL — the run greens each one before it settles.
