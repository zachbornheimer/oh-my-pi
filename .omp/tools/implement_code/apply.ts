import { isAbsolute, relative, resolve } from "node:path";
import { contentHash } from "./content_hash.js";
import type { HostMachine } from "./machine.js";
import type { CheckCommand, CheckResult, FileChange, ImplementedCode } from "./schemas.js";

const OUTPUT_TAIL_CHARS = 2000;

/** The absolute path of a planned file, refused when it would land outside the repo. */
function targetOf(repo: string, file: FileChange): string {
  const target = resolve(repo, file.path);
  const from = relative(repo, target);
  if (from === "" || from.startsWith("..") || isAbsolute(from)) {
    throw new Error(`implement_code: refusing to apply, nothing was written: ${file.path} is outside the repo`);
  }
  return target;
}

/** Why a file cannot be written the way the plan says, or undefined when it can. */
async function conflictOf(file: FileChange, target: string, machine: HostMachine): Promise<string | undefined> {
  const current = await machine.readTextFile(target);
  if (file.action === "create") return current === undefined ? undefined : `${file.path} now exists`;
  if (current === undefined) return `${file.path} is gone`;
  return contentHash(current) === file.base_sha256 ? undefined : `${file.path} changed since it was read`;
}

async function runCheck(check: CheckCommand, repo: string, machine: HostMachine): Promise<CheckResult> {
  const ran = await machine.run("sh", ["-c", check.run], { cwd: repo });
  const output = `${ran.stdout}${ran.stderr}`.trim();
  return { ...check, passed: ran.code === 0, exit_code: ran.code, output_tail: output.slice(-OUTPUT_TAIL_CHARS) };
}

/**
 * Writes the planned files into the repo and runs the planned checks. It refuses, writing nothing, when a file to
 * create now exists, a file to edit is no longer the text the plan was made from, or a path leaves the repo. It never
 * commits; a failing check is reported, not thrown.
 */
export async function applyPlan(plan: ImplementedCode, machine: HostMachine): Promise<ImplementedCode> {
  const targets = plan.files.map((file) => targetOf(plan.repo, file));
  const conflicts = (await Promise.all(plan.files.map((file, index) => conflictOf(file, targets[index]!, machine)))).filter(
    (conflict): conflict is string => conflict !== undefined,
  );
  if (conflicts.length > 0) {
    throw new Error(`implement_code: refusing to apply, nothing was written: ${conflicts.join("; ")}`);
  }
  const written: { path: string; action: FileChange["action"] }[] = [];
  for (const [index, file] of plan.files.entries()) {
    try {
      await machine.writeTextFile(targets[index]!, file.content);
    } catch (error) {
      const done = written.map((entry) => entry.path).join(", ") || "none";
      throw new Error(`implement_code: ${(error as Error).message}; already written: ${done}`);
    }
    written.push({ path: file.path, action: file.action });
  }
  const checks: CheckResult[] = [];
  for (const check of plan.checks) checks.push(await runCheck(check, plan.repo, machine));
  return { ...plan, applied: { written, checks } };
}
