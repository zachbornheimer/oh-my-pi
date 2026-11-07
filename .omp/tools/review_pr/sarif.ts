import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { arr, bool, obj, optStr, str } from "./decode.js";
import type { ReviewFinding } from "./types.js";

/** A source region of a SARIF location or fix, as the log states it. */
interface Region {
  startLine: number;
  endLine?: number;
  startColumn?: number;
}

interface Rule {
  id: string;
  level?: string;
  helpUri?: string;
}

const SEVERITY: Readonly<Record<string, string>> = { error: "high", warning: "medium", note: "low" };

/** A positive integer, or undefined when absent. */
function position(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${where}: expected a positive integer`);
  return value;
}

function region(value: unknown, where: string): Region | undefined {
  if (value === undefined || value === null) return undefined;
  const node = obj(value, where);
  const startLine = position(node.startLine, `${where}.startLine`);
  if (startLine === undefined) throw new Error(`${where}.startLine: expected a positive integer`);
  const endLine = position(node.endLine, `${where}.endLine`);
  const startColumn = position(node.startColumn, `${where}.startColumn`);
  return { startLine, ...(endLine === undefined ? {} : { endLine }), ...(startColumn === undefined ? {} : { startColumn }) };
}

/** The `text` of a `{ text }` message, or undefined when there is no message. */
function messageText(value: unknown, where: string): string | undefined {
  return value === undefined || value === null ? undefined : str(obj(value, where).text, `${where}.text`);
}

/** A fingerprint table: string values only; an absent table is empty. */
function fingerprints(value: unknown, where: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  return Object.fromEntries(Object.entries(obj(value, where)).map(([key, item]) => [key, str(item, `${where}.${key}`)]));
}

function rules(run: Record<string, unknown>, where: string): Map<string, Rule> {
  const driver = run.tool === undefined || run.tool === null ? undefined : obj(obj(run.tool, `${where}.tool`).driver ?? {}, `${where}.tool.driver`);
  const list = driver?.rules === undefined || driver.rules === null ? [] : arr(driver.rules, `${where}.tool.driver.rules`);
  const byId = new Map<string, Rule>();
  list.forEach((entry, index) => {
    const rule = obj(entry, `${where}.rules[${index}]`);
    const id = str(rule.id, `${where}.rules[${index}].id`);
    const configuration = rule.defaultConfiguration === undefined ? undefined : obj(rule.defaultConfiguration, `${where}.rules[${index}].defaultConfiguration`);
    const level = configuration === undefined ? undefined : str(configuration.level, `${where}.rules[${index}].defaultConfiguration.level`);
    byId.set(id, { id, ...(level === undefined ? {} : { level }), ...(rule.helpUri === undefined ? {} : { helpUri: str(rule.helpUri, `${where}.rules[${index}].helpUri`) }) });
  });
  return byId;
}

/** Every error the log's invocations report. An error notification is a failed run even when `executionSuccessful` is true. */
function runErrors(runs: Record<string, unknown>[]): string[] {
  const errors: string[] = [];
  runs.forEach((run, runAt) => {
    if (run.invocations === undefined || run.invocations === null) return;
    arr(run.invocations, `runs[${runAt}].invocations`).forEach((entry, at) => {
      const where = `runs[${runAt}].invocations[${at}]`;
      const invocation = obj(entry, where);
      const notes = invocation.toolExecutionNotifications === undefined || invocation.toolExecutionNotifications === null
        ? []
        : arr(invocation.toolExecutionNotifications, `${where}.toolExecutionNotifications`);
      const messages: string[] = [];
      notes.forEach((noteEntry, noteAt) => {
        const note = obj(noteEntry, `${where}.toolExecutionNotifications[${noteAt}]`);
        if (note.level !== "error") return;
        const text = messageText(note.message, `${where}.toolExecutionNotifications[${noteAt}].message`);
        if (text) messages.push(text);
      });
      const successful = invocation.executionSuccessful === undefined ? undefined : bool(invocation.executionSuccessful, `${where}.executionSuccessful`);
      if (successful === false && messages.length === 0) errors.push("executionSuccessful is false");
      else errors.push(...messages);
    });
  });
  return errors;
}

/**
 * Turns one SARIF log into findings anchored to new-side lines. Throws when any run did not finish, because a partial
 * review must not be posted as if it were complete. `root` is the reviewed checkout, used to quote the replaced code.
 */
export async function findingsFromSarif(sarif: unknown, root: string): Promise<ReviewFinding[]> {
  const runs = arr(obj(sarif, "SARIF log").runs, "SARIF log.runs").map((run, index) => obj(run, `runs[${index}]`));
  // Semgrep reports a broken baseline as an error notification with zero results; without this it would post as clean.
  const errors = runErrors(runs);
  if (errors.length > 0) throw new Error(`SARIF run did not finish: ${errors.join("; ")}`);
  const findings: ReviewFinding[] = [];
  for (const [runAt, run] of runs.entries()) {
    const known = rules(run, `runs[${runAt}]`);
    const results = run.results === undefined || run.results === null ? [] : arr(run.results, `runs[${runAt}].results`);
    for (const [at, entry] of results.entries()) {
      const where = `runs[${runAt}].results[${at}]`;
      const result = obj(entry, where);
      const content = messageText(result.message, `${where}.message`);
      if (content === undefined) throw new Error(`${where}.message: expected an object`);
      const locations = result.locations === undefined || result.locations === null ? [] : arr(result.locations, `${where}.locations`);
      const physical = locations[0] === undefined ? undefined : obj(locations[0], `${where}.locations[0]`).physicalLocation;
      const place = physical === undefined || physical === null ? undefined : obj(physical, `${where}.physicalLocation`);
      const located = place === undefined ? undefined : region(place.region, `${where}.region`);
      const artifact = place?.artifactLocation === undefined || place.artifactLocation === null ? undefined : obj(place.artifactLocation, `${where}.artifactLocation`);
      const uri = artifact === undefined ? undefined : optStr(artifact.uri, `${where}.artifactLocation.uri`);
      const path = uri === undefined ? undefined : containedPath(root, uri);
      if (path === undefined || located === undefined) continue;
      const ruleId = optStr(result.ruleId, `${where}.ruleId`);
      const rule = ruleId === undefined ? undefined : known.get(ruleId);
      const level = optStr(result.level, `${where}.level`) ?? rule?.level;
      const fix = firstReplacement(result.fixes, `${where}.fixes`);
      findings.push({
        path,
        content: content.trim(),
        start_line: located.startLine,
        end_line: located.endLine ?? located.startLine,
        severity: level === undefined ? undefined : SEVERITY[level],
        category: ruleId,
        existing_code: await quotedCode(root, path, fix?.deleted),
        suggestion_code: fix?.inserted,
        fingerprint: stableFingerprint({
          ...fingerprints(result.fingerprints, `${where}.fingerprints`),
          ...fingerprints(result.partialFingerprints, `${where}.partialFingerprints`),
        }),
        reference: rule?.helpUri,
      });
    }
  }
  return findings;
}

/** The first fix's first replacement: the region it deletes and the text it inserts. */
function firstReplacement(fixes: unknown, where: string): { deleted?: Region; inserted?: string } | undefined {
  if (fixes === undefined || fixes === null) return undefined;
  const fix = arr(fixes, where)[0];
  if (fix === undefined) return undefined;
  const changes = obj(fix, `${where}[0]`).artifactChanges;
  const change = changes === undefined || changes === null ? undefined : arr(changes, `${where}[0].artifactChanges`)[0];
  if (change === undefined) return undefined;
  const replacements = obj(change, `${where}[0].artifactChanges[0]`).replacements;
  const replacement = arr(replacements, `${where}[0].artifactChanges[0].replacements`)[0];
  if (replacement === undefined) return undefined;
  const node = obj(replacement, `${where}[0].artifactChanges[0].replacements[0]`);
  const deleted = region(node.deletedRegion, `${where}[0].artifactChanges[0].replacements[0].deletedRegion`);
  const inserted = node.insertedContent === undefined || node.insertedContent === null
    ? undefined
    : str(obj(node.insertedContent, "insertedContent").text, "insertedContent.text");
  return { ...(deleted === undefined ? {} : { deleted }), ...(inserted === undefined ? {} : { inserted }) };
}

/**
 * A finding's id from the reviewer's first fingerprint. Semgrep's matchBasedId is `<hex>_<n>`; two matches in one file
 * share the hex and differ only in `<n>`, so the suffix has to be part of the id. A bare hex prefix stays the first
 * 16 characters, which already-posted reviews use. Anything else gives no id and the plan derives one.
 */
function stableFingerprint(prints: Readonly<Record<string, string>>): string | undefined {
  const value = Object.values(prints)[0];
  const match = value === undefined ? null : /^([0-9a-f]+)(_[0-9]+)?$/i.exec(value);
  if (value === undefined || match === null) return undefined;
  if (match[2] === undefined) return match[1]!.slice(0, 16);
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** A repo-relative path, or undefined when the URI leaves the checkout or is absolute. */
export function containedPath(root: string, uri: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || isAbsolute(decoded)) return undefined;
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, decoded);
  const rel = relative(rootResolved, target);
  // A leading ".." is an escape only as a whole path segment: a file named `..foo` is inside the checkout.
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return undefined;
  return rel;
}

/** The whole lines a fix deletes, as the checkout holds them, so a rerun recognizes the same finding. */
async function quotedCode(root: string, path: string, deleted: Region | undefined): Promise<string | undefined> {
  const contained = containedPath(root, path);
  if (deleted === undefined || contained === undefined || (deleted.startColumn !== undefined && deleted.startColumn !== 1)) {
    return undefined;
  }
  const text = await readFile(resolve(root, contained), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  const end = deleted.endLine ?? deleted.startLine;
  if (end < deleted.startLine || end > lines.length) return undefined;
  return lines.slice(deleted.startLine - 1, end).join("\n");
}
