import { claudeRecordTurns } from "./claude.js";
import { codexRecordTurns } from "./codex.js";
import { cursorRecordTurns } from "./cursor.js";
import { grokRecordTurns } from "./grok.js";
import { stringField } from "./records.js";
import type { RecordParser } from "./records.js";

/** The key every captured line carries: `<agentmux harness>:<session id>`. */
const SOURCE_KEY = "_agentmux_source";

/** agentmux's harness names (`claude-code`, `grok`, `codex`, `cursor`) to the parser of that harness's lines. */
const PARSER_BY_AGENTMUX_HARNESS: Readonly<Record<string, RecordParser>> = {
  "claude-code": claudeRecordTurns,
  grok: grokRecordTurns,
  codex: codexRecordTurns,
  cursor: cursorRecordTurns,
};

/**
 * A project's combined transcript, `~/.config/agentmux/projects/<id>/transcript.jsonl`: the captured lines of every
 * session linked to the project, interleaved. Each line is read by its own harness's parser and its turns are
 * stamped with the session they came from, so pairing never mixes two sessions. Lines of a harness with no parser
 * (or with no source) are left out.
 */
export const agentmuxProjectRecordTurns: RecordParser = (record) => {
  const source = stringField(record, SOURCE_KEY);
  const harness = source.slice(0, Math.max(0, source.indexOf(":")));
  const parse = PARSER_BY_AGENTMUX_HARNESS[harness];
  return parse === undefined ? [] : parse(record).map((turn) => ({ ...turn, session: source }));
};
