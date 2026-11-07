import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHARACTERS_PER_TOKEN = 3;
const MAX_MATCH_CHARACTERS = 800;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;

export type EvidenceKind = "output-field" | "output-contract" | "model-contract" | "model-call" | "return-value";
export interface Evidence {
  kind: EvidenceKind;
  file: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}
export interface CollectFailureEvidenceInput {
  error: string;
  maxTokens: number;
}
export interface CollectFailureEvidenceOutput {
  status: "found" | "not_found";
  evidence: Evidence[];
  truncated: boolean;
  estimatedTokens: number;
  wallMs: number;
}

type SourceFile = { path: string; relativePath: string };
type SourceTargets = { implementation?: SourceFile; schema?: SourceFile };
export type AstMatch = {
  text: string;
  range: { start: { line: number }; end: { line: number } };
};
export type Search = (
  file: SourceFile,
  pattern: string,
  signal?: AbortSignal,
  selector?: string,
) => Promise<AstMatch[]>;

type Query = {
  kind: EvidenceKind;
  file: SourceFile;
  pattern: string;
  selector?: string;
  relevant: (match: AstMatch) => boolean;
};

/** The binary that runs structural searches. */
export const AST_GREP_BINARY = "ast-grep";

/** Host-owned root: EVIDENCE_REPOSITORY_ROOT, else the session's working directory. Never a model-supplied path. */
export function evidenceRepositoryRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EVIDENCE_REPOSITORY_ROOT;
  return configured !== undefined && configured !== "" ? configured : cwd;
}

export async function collectFailureEvidence(
  repositoryRoot: string,
  request: CollectFailureEvidenceInput,
  search: Search = (file, pattern, signal, selector) => searchAst(AST_GREP_BINARY, file, pattern, signal, selector),
  signal?: AbortSignal,
): Promise<CollectFailureEvidenceOutput> {
  const started = performance.now();
  const root = await realpath(repositoryRoot);
  const targets = await resolveTargets(root, request.error);
  const queries = queriesFor(targets, failureField(request.error));
  const matches = await Promise.all(
    queries.map(async (query) => ({ query, matches: await search(query.file, query.pattern, signal, query.selector) })),
  );

  const candidates: Evidence[] = [];
  const seen = new Set<string>();
  for (const { query, matches: found } of matches) {
    for (const match of found.filter(query.relevant)) {
      const identity = `${query.file.relativePath}:${match.range.start.line}:${match.range.end.line}`;
      if (seen.has(identity) || candidates.some((item) => item.kind === query.kind)) continue;
      seen.add(identity);
      candidates.push({
        kind: query.kind,
        file: query.file.relativePath,
        startLine: match.range.start.line + 1,
        endLine: match.range.end.line + 1,
        excerpt: match.text.trim().slice(0, MAX_MATCH_CHARACTERS),
      });
      break;
    }
  }

  const evidence: Evidence[] = [];
  const maxCharacters = request.maxTokens * CHARACTERS_PER_TOKEN;
  let truncated = false;
  for (const candidate of candidates) {
    const next = [...evidence, candidate];
    const trial = formatEvidence({ status: "found", evidence: next, truncated: false, estimatedTokens: 0, wallMs: 0 });
    if (trial.length > maxCharacters) {
      truncated = true;
      continue;
    }
    evidence.push(candidate);
  }
  truncated ||= evidence.some((item) => item.excerpt.length >= MAX_MATCH_CHARACTERS);
  const status = evidence.length ? "found" : "not_found";
  const wallMs = Math.round(performance.now() - started);
  const base = { status, evidence, truncated, estimatedTokens: 0, wallMs } as const;
  return { ...base, estimatedTokens: Math.ceil(formatEvidence(base).length / CHARACTERS_PER_TOKEN) };
}

export function formatEvidence(result: CollectFailureEvidenceOutput): string {
  const lines = result.evidence.map(
    (item) => `${item.kind} ${item.file}:${item.startLine}-${item.endLine}\n${item.excerpt}`,
  );
  return [`Evidence: ${result.status}${result.truncated ? " (truncated)" : ""}`, ...lines].join("\n\n");
}

async function resolveTargets(root: string, error: string): Promise<SourceTargets> {
  const capability = /\b(?:capability failed:\s*|invalid (?:input|output) for\s+)([a-z][a-z0-9_.-]*)/i.exec(error)?.[1];
  const paths: string[] = [];
  if (capability && /^[a-z][a-z0-9_.-]{0,80}$/i.test(capability)) {
    const directory = capability.replaceAll(".", "_");
    for (const prefix of ["src/capability", "mastra/src/capability"]) {
      paths.push(`${prefix}/${directory}/${directory}.ts`, `${prefix}/${directory}/schemas.ts`);
    }
  }
  for (const match of error.matchAll(/\b((?:mastra\/)?src\/[a-zA-Z0-9_./-]+\.tsx?)(?::\d+)?/g)) {
    paths.push(match[1]!);
    const folder = match[1]!.slice(0, match[1]!.lastIndexOf("/"));
    paths.push(`${folder}/schemas.ts`);
  }
  const files = (await Promise.all(paths.map((path) => safeSourceFile(root, path))))
    .filter((file): file is SourceFile => file !== undefined);
  return {
    implementation: files.find((file) => !file.relativePath.endsWith("/schemas.ts")),
    schema: files.find((file) => file.relativePath.endsWith("/schemas.ts")),
  };
}

async function safeSourceFile(root: string, sourcePath: string): Promise<SourceFile | undefined> {
  const absolute = resolve(root, sourcePath);
  if (!isInside(root, absolute)) return undefined;
  try {
    const canonical = await realpath(absolute);
    if (!isInside(root, canonical) || !(await stat(canonical)).isFile()) return undefined;
    return { path: canonical, relativePath: relative(root, canonical) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
}

function failureField(error: string): string | undefined {
  const field = /(?:invalid output:\s*|returned an invalid output:\s*)([A-Za-z_$][\w$]*)\s*:/i.exec(error)?.[1];
  return field && /^[A-Za-z_$][\w$]*$/.test(field) ? field : undefined;
}

function queriesFor(targets: SourceTargets, field?: string): Query[] {
  const queries: Query[] = [];
  if (targets.schema) {
    if (field) {
      queries.push({
        kind: "output-field",
        file: targets.schema,
        pattern: `({ ${field}: $VALUE })`,
        selector: "pair",
        relevant: () => true,
      });
    }
    queries.push({
      kind: "output-contract",
      file: targets.schema,
      pattern: "export const $NAME = $VALUE",
      relevant: ({ text }) =>
        /\b(?:output|reply).*schema\b/i.test(text.slice(0, 110)) && (!field || text.includes(field)),
    });
  }
  if (targets.implementation) {
    queries.push(
      {
        kind: "model-contract",
        file: targets.implementation,
        pattern: "const $NAME = $VALUE",
        relevant: ({ text }) => /\b[A-Z_]*SCHEMA\b/.test(text.slice(0, 110)),
      },
      {
        kind: "model-call",
        file: targets.implementation,
        pattern: "ctx.generate($$$ARGS)",
        relevant: () => true,
      },
      {
        kind: "return-value",
        file: targets.implementation,
        pattern: "return { $$$PROPS }",
        relevant: ({ text }) => text.includes("summary") || (field !== undefined && text.includes(field)),
      },
    );
  }
  return queries;
}

export async function searchAst(
  binary: string,
  file: SourceFile,
  pattern: string,
  signal?: AbortSignal,
  selector?: string,
): Promise<AstMatch[]> {
  const args = ["run", "--pattern", pattern, "--lang", "ts", "--json=stream", "--custom-languages=ignore"];
  if (selector !== undefined) args.push("--selector", selector);
  args.push(file.path);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      signal,
      encoding: "utf8",
    }));
  } catch (error) {
    const failure = error as Error & { code?: string | number };
    if (failure.code === 1 || failure.code === "1") return [];
    if (failure.code === "ENOENT") {
      throw new Error("ast-grep is not installed or is missing from PATH", { cause: error });
    }
    throw new Error(`ast-grep failed for ${file.relativePath}: ${failure.message}`, { cause: error });
  }
  return stdout.split("\n").filter(Boolean).map((line) => {
    const value = JSON.parse(line) as AstMatch;
    if (
      typeof value.text !== "string" || !Number.isInteger(value.range?.start?.line)
      || !Number.isInteger(value.range?.end?.line)
    ) {
      throw new Error(`Invalid ast-grep JSON result for ${file.relativePath}`);
    }
    return value;
  });
}
