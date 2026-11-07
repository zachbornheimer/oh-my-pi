# NOTICE

Parts of this capability are adapted from Ouroboros, github.com/Q00/ouroboros at commit
05d2718de3edf7ba25de920c78652f646b7a9704, used under the MIT License below.

Lifted from:

- `src/ouroboros/bigbang/ambiguity.py`: the threshold, floors and weights (lines 37-59), the rubric lines (86-92), the milestones (174-195), the floor failures and the gate (299-336), the overall score (852) and the scoring prompt's deferral rule (632-666). Here: `ambiguity.ts`, `prompts.ts`.
- `src/ouroboros/bigbang/interview.py`: `MIN_ROUNDS_BEFORE_EARLY_EXIT` (57), `RESPONSE_CONTRACT` and the toolless interviewer prompt (100-121), the question candidate panel and its deterministic pick (613-756) and the persona request (1107-1149). Here: `interview.ts`, `candidates.ts`, `prompts.ts`.
- `src/ouroboros/agents/contrarian.md`, `architect.md`, `researcher.md`: condensed into the persona lenses in `candidates.ts`.

---

MIT License

Copyright (c) 2025 Q00

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
