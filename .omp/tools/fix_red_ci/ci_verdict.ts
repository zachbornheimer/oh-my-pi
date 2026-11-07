export type CiVerdict = "green" | "red" | "pending" | "no-checks" | "timed-out";

export type CheckRollupEntry = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
};

export type CiReading = { headSha: string; rollup: readonly CheckRollupEntry[] };
export type CiResult = CiReading & { verdict: Exclude<CiVerdict, "pending"> };

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
export function ciVerdict(rollup: readonly CheckRollupEntry[]): Exclude<CiVerdict, "timed-out"> {
  if (rollup.length === 0) return "no-checks";
  const verdicts = rollup.map(checkVerdict);
  if (verdicts.includes("pending")) return "pending";
  return verdicts.includes("red") ? "red" : "green";
}

/** Waits for checks, allowing initial registration but never treating missing checks as passing. */
export async function settledCiVerdict(
  read: () => Promise<CiReading>,
  wait: () => Promise<void>,
  maxPolls = 60,
  registrationPolls = 2,
): Promise<CiResult> {
  if (
    !Number.isSafeInteger(maxPolls) || maxPolls < 1
    || !Number.isSafeInteger(registrationPolls) || registrationPolls < 0
  ) {
    throw new Error("Invalid CI polling configuration");
  }

  let last: CiReading | undefined;
  let emptyPolls = 0;

  for (let poll = 0; poll < maxPolls; poll++) {
    const current = await read();
    if (last?.headSha !== current.headSha) emptyPolls = 0;
    last = current;

    const verdict = ciVerdict(current.rollup);
    if (verdict === "no-checks") {
      if (++emptyPolls > registrationPolls) return { ...current, verdict };
    } else if (verdict !== "pending") {
      return { ...current, verdict };
    }

    if (poll + 1 < maxPolls) await wait();
  }

  if (!last) throw new Error("No CI observation was made");
  return { ...last, verdict: "timed-out" };
}
