export type CiVerdict = "green" | "red" | "pending" | "no-checks";

export type CheckRollupEntry = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
};

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Checks cannot pass until every one has reached a terminal state. */
function checkVerdict(check: CheckRollupEntry): "green" | "red" | "pending" {
  if (check.__typename === "CheckRun") {
    if (check.status !== "COMPLETED") return "pending";
    return PASSING.has(check.conclusion ?? "") ? "green" : "red";
  }
  if (check.__typename === "StatusContext") {
    if (check.state === "PENDING" || check.state === "EXPECTED") return "pending";
    return check.state === "SUCCESS" ? "green" : "red";
  }
  return "red"; // Fail closed on unknown check types.
}

/** Empty check lists are not proof of green CI. */
export function ciVerdict(rollup: readonly CheckRollupEntry[]): CiVerdict {
  if (rollup.length === 0) return "no-checks";
  const verdicts = rollup.map(checkVerdict);
  if (verdicts.includes("pending")) return "pending";
  return verdicts.includes("red") ? "red" : "green";
}
