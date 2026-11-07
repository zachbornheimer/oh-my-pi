/** What one review returns, and how a round's two reviews and the test gate fold into one verdict. */

export const SEVERITIES = ["blocking", "suggestion", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One review finding: where in the diff, what is wrong, and how to fix it. */
export interface Finding {
  severity: Severity;
  path: string;
  line?: number;
  description: string;
  fix?: string;
}

/** A finding that never blocks a landing: a suggestion or a nit. */
export type Suggestion = Finding & { severity: "suggestion" | "nit" };

/** Validates a review reply `{"findings":[...]}`; throws naming the first bad field. Unknown keys are refused. */
export function parseFindings(value: unknown): Finding[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the reply must be an object with a findings array");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "findings")) throw new Error(`unexpected key ${JSON.stringify(keys.find((key) => key !== "findings"))}; only findings is allowed`);
  const list = (value as { findings?: unknown }).findings;
  if (!Array.isArray(list)) throw new Error("findings must be an array (empty when the diff is clean)");
  return list.map((entry, index) => {
    const at = `findings[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${at} must be an object`);
    const raw = entry as Record<string, unknown>;
    const extra = Object.keys(raw).find((key) => !["severity", "path", "line", "description", "fix"].includes(key));
    if (extra !== undefined) throw new Error(`${at} has unexpected key ${JSON.stringify(extra)}`);
    if (typeof raw.severity !== "string" || !(SEVERITIES as readonly string[]).includes(raw.severity)) {
      throw new Error(`${at}.severity must be blocking, suggestion or nit`);
    }
    if (typeof raw.path !== "string" || raw.path === "") throw new Error(`${at}.path must be a non-empty string`);
    if (typeof raw.description !== "string" || raw.description === "") throw new Error(`${at}.description must be a non-empty string`);
    if (raw.line !== undefined && (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1)) {
      throw new Error(`${at}.line must be a positive integer when present`);
    }
    if (raw.fix !== undefined && typeof raw.fix !== "string") throw new Error(`${at}.fix must be a string when present`);
    return {
      severity: raw.severity as Severity,
      path: raw.path,
      ...(raw.line === undefined ? {} : { line: raw.line as number }),
      description: raw.description,
      ...(raw.fix === undefined ? {} : { fix: raw.fix }),
    };
  });
}

/** One round's three answers: the code review, the security review, and the test gate. */
export interface RoundInputs {
  readonly codeFindings: readonly Finding[];
  readonly securityFindings: readonly Finding[];
  readonly tests: { readonly ok: boolean; readonly output: string };
}

/** What one round settles: land, or fix again with these blockers. */
export interface RoundVerdict {
  readonly verdict: "land" | "fix";
  /** The findings that must be fixed before landing: blocking ones and, on red tests, the test output. */
  readonly blockers: readonly string[];
  /** Everything the landing report still carries: suggestions and nits from both reviews. */
  readonly suggestions: readonly Suggestion[];
}

function findingLine(finding: Finding): string {
  const site = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
  const fix = finding.fix === undefined ? "" : ` Fix: ${finding.fix}`;
  return `[${finding.severity}] ${site}: ${finding.description}.${fix}`;
}

const notBlocking = (finding: Finding): finding is Suggestion => finding.severity !== "blocking";

/**
 * Land only when no blocking finding stands in either review and the repo's own test gate is green; otherwise fix,
 * carrying exactly the blockers. Suggestions and nits never block a landing; they ride along in the report.
 */
export function amalgamateFindings(inputs: RoundInputs): RoundVerdict {
  const blockers = [
    ...inputs.codeFindings.filter((finding) => finding.severity === "blocking").map(findingLine),
    ...inputs.securityFindings.filter((finding) => finding.severity === "blocking").map(findingLine),
  ];
  if (!inputs.tests.ok) blockers.push(`The repo's test gate failed:\n${inputs.tests.output}`);
  return {
    verdict: blockers.length === 0 ? "land" : "fix",
    blockers,
    suggestions: [...inputs.codeFindings, ...inputs.securityFindings].filter(notBlocking),
  };
}

/** The prompt that asks the implementer to fix one round's blockers. */
export function fixPrompt(blockers: readonly string[]): string {
  return `Fix these findings from the last review round:\n\n${blockers.map((line) => `- ${line}`).join("\n")}`;
}
