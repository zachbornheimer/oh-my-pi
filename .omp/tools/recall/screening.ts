/**
 * Deterministic screening recall applies to recorded text. Two ports of Go regexps
 * (agentmux `internal/capabilities/recall.go` secretPattern, `internal/board/prescreen.go`).
 * Go's `\s` and `\S` are ASCII-only (no vertical tab, no Unicode spaces); JS's are not, so both
 * are spelled out. The `u` flag makes `{n,m}` windows count code points as Go counts runes
 * and gives Go's simple case folding. One known gap: under `iu`, `\b` also treats U+017F and
 * U+212A as word characters (Go's `\b` is ASCII-only).
 */

const SPACE = String.raw`[\t\n\f\r ]`;
const NOT_SPACE = String.raw`[^\t\n\f\r ]`;

const compile = (source: string): RegExp =>
  new RegExp(source.replaceAll("\\s", SPACE).replaceAll("\\S", NOT_SPACE), "iu");

/** Text that looks like it carries a credential; excluded from recall entirely, never clipped or stubbed. */
export const SECRET_PATTERN = compile(
  String
    .raw`\b(sk-[a-z0-9]{16,}|akia[0-9a-z]{16}|gh[pousr]_[a-z0-9]{20,}|xox[abp]-[a-z0-9-]{10,})|(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----`,
);

/** The closed set of risks screening can flag, in agentmux's stable order (`allReasons`). */
export const REASON_CODES = [
  "override_instructions",
  "request_secrets",
  "privileged_action",
  "claims_authority",
  "obfuscated_payload",
  "exfiltration_link",
  "requests_action",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const RULES: Readonly<Record<ReasonCode, RegExp>> = {
  override_instructions: compile(
    String
      .raw`\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|your|all|any)\b[^.\n]{0,30}\b(instructions?|rules|prompt|guidelines)\b|\bnew instructions\s*:|\byou are now\b`,
  ),
  request_secrets: compile(
    String
      .raw`(\.ssh/|id_rsa|id_ed25519|\.aws/credentials|\.env\b|\.netrc)|\b(cat|print|show|send|post|paste|dump|reveal|share|give|read|echo)\b[^.\n]{0,40}\b(api[_ -]?keys?|secrets?|passwords?|tokens?|credentials|private keys?)\b`,
  ),
  privileged_action: compile(
    String
      .raw`\brm\s+-\S*[rf]|\bsudo\b|settings\.json|permissions\.allow|Bash\(\*\)|--no-verify|force[- ]push|push --force|reset --hard|\bgit hooks?\b|drop (table|database)|\bmkfs\b|\bchmod\s+\S*7`,
  ),
  claims_authority: compile(
    String
      .raw`\b(user|operator|admin|owner|system)\b[^.\n]{0,30}\b(already )?(approved|authori[sz]ed|allowed|confirmed|granted)\b|\b(i am|this is|message from) (the )?(user|admin|system|operator)\b|<agentmux-system>`,
  ),
  obfuscated_payload: compile(
    String.raw`[A-Za-z0-9+/]{80,}={0,2}|(\\x[0-9a-fA-F]{2}){4,}|[\u200b-\u200f\u2060\ufeff]`,
  ),
  exfiltration_link: compile(
    String
      .raw`https?://\S+\?\S*(key|token|secret|data)=|\b(curl|wget)\b[^\n]{0,80}https?://|\b(send|post|upload)\b[^.\n]{0,30}\bto\b[^.\n]{0,10}https?://`,
  ),
  requests_action: compile(
    String
      .raw`^\s*(please\s+)?(re-?run|run|execute|restart|fix|delete)\b|\bplease\b[^.\n]{0,20}\b(re-?run|run|execute|fix|check|restart)\b`,
  ),
};

/** Signals strong enough to withhold a body on their own (agentmux `quarantineReasons`). */
const QUARANTINE_REASONS: ReadonlySet<ReasonCode> = new Set([
  "override_instructions",
  "request_secrets",
  "privileged_action",
]);

export interface Screening {
  readonly quarantined: boolean;
  readonly reasons: readonly ReasonCode[];
}

/**
 * agentmux `board.PreScreener.Screen` reduced to what recall reads: whether the body is
 * quarantined (a quarantine reason, or claimed authority paired with a privileged action)
 * and the reasons found, in stable order.
 */
export function screen(body: string): Screening {
  const reasons = REASON_CODES.filter((reason) => RULES[reason].test(body));
  const quarantined = reasons.some((reason) => QUARANTINE_REASONS.has(reason))
    || (reasons.includes("claims_authority") && reasons.includes("privileged_action"));
  return { quarantined, reasons };
}
