# fixtures

`claude-tool-calls.jsonl`: a hand-written Claude Code session in the real record shape (`user` / `assistant` records with `tool_use` and `tool_result` blocks), scrubbed: home is `/Users/someone`, the site is `shop.example.com`, ids are `toolu_01`... It holds reads (`Read`, `ls`, `rg`), a failed `mise run build` that is retried and succeeds after an `Edit`, a deploy, a health check and a smoke run, so the tests can pair, drop, collapse and parameterize.

`webmaster-operate.md`: an excerpt of `~/.agents/available-skills/webmaster/SKILL.md` (frontmatter, usage, two hard rules, rule 8 and the whole "Operate: the full loop" section, verbatim), so the document tests do not depend on a skill installed on the machine. The live smoke reads the real file.

`zwsip-page-measure-then-rework.yaml`: the reference target for the zwsip/isjac canary (see the capability README, known gaps).
