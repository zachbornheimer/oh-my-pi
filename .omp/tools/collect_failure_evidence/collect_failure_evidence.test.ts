import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFailureEvidence, evidenceRepositoryRoot, formatEvidence, searchAst } from "./collect.ts";
import factory from "./index.ts";

const failure =
  "capability failed: summarize returned an invalid output: focus: Invalid input: expected array, received undefined";
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evidence-test-"));
  roots.push(root);
  const directory = join(root, "mastra/src/capability/summarize");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "schemas.ts"),
    [
      "import { z } from \"zod\";",
      "export const summary_reply_schema = z.object({",
      "  summary: z.string(),",
      "  focus: z.array(z.object({ question: z.string() })),",
      "});",
      "export const summarize_output_schema = summary_reply_schema.extend({ raw_output: z.object({ path: z.string() }) });",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "summarize.ts"),
    [
      "const SUMMARY_SCHEMA = { required: ['summary'], properties: { summary: { type: 'string' } } };",
      "async function run(ctx: any, summary_reply_schema: any, raw: any) {",
      "  const answered = await ctx.generate('prompt', summary_reply_schema, { jsonSchema: SUMMARY_SCHEMA });",
      "  return { summary: answered.value.summary, raw_output: raw };",
      "}",
    ].join("\n"),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("collectFailureEvidence (fake search)", () => {
  it("returns no evidence without a resolvable capability or source path", async () => {
    const root = await fixture();
    const result = await collectFailureEvidence(root, { error: "unknown error", maxTokens: 1000 }, async () => {
      throw new Error("must not search");
    });
    expect(result).toMatchObject({ status: "not_found", evidence: [], truncated: false });
  });

  it("uses a bounded output even when a search returns enormous AST nodes", async () => {
    const root = await fixture();
    const calls: string[] = [];
    const result = await collectFailureEvidence(root, { error: failure, maxTokens: 250 }, async (_file, pattern) => {
      calls.push(pattern);
      const text = pattern.includes("focus: $VALUE")
        ? "focus: z.array(z.string())"
        : `const BIG_SCHEMA = '${"x".repeat(50_000)}'`;
      return [{ text, range: { start: { line: 5 }, end: { line: 6 } } }];
    });
    expect(calls).toContain("({ focus: $VALUE })");
    expect(result.status).toBe("found");
    expect(result.estimatedTokens).toBeLessThanOrEqual(250);
    expect(formatEvidence(result).length).toBeLessThanOrEqual(750);
    expect(result.evidence[0]).toMatchObject({ kind: "output-field", startLine: 6 });
    expect(result.truncated).toBe(true);
  });

  it("does not inspect symlinks that escape the configured repository", async () => {
    const root = await fixture();
    const external = await mkdtemp(join(tmpdir(), "evidence-external-"));
    roots.push(external);
    await writeFile(join(external, "outside.ts"), "export const secret = 'never read';");
    await symlink(join(external, "outside.ts"), join(root, "mastra/src/capability/summarize/outside.ts"));
    const result = await collectFailureEvidence(
      root,
      { error: "mastra/src/capability/summarize/outside.ts:1: failed", maxTokens: 1000 },
      async (file) => {
        if (file.relativePath.endsWith("outside.ts")) throw new Error("should not inspect an external symlink");
        return [];
      },
    );
    expect(result.status).toBe("not_found");
  });

  it("does not follow `..` segments in a path named by the error text", async () => {
    const root = await fixture();
    const result = await collectFailureEvidence(
      root,
      { error: "src/../../../../etc/hosts.ts:3 failed", maxTokens: 1000 },
      async () => {
        throw new Error("should not search outside the root");
      },
    );
    expect(result.status).toBe("not_found");
  });

  it("maps match lines to 1-based and keeps one evidence item per kind", async () => {
    const root = await fixture();
    const result = await collectFailureEvidence(root, { error: failure, maxTokens: 2500 }, async (_file, pattern) => {
      if (pattern.includes("ctx.generate")) {
        return [
          { text: "ctx.generate('a')", range: { start: { line: 2 }, end: { line: 2 } } },
          { text: "ctx.generate('b')", range: { start: { line: 9 }, end: { line: 9 } } },
        ];
      }
      return [];
    });
    expect(result.evidence).toEqual([
      {
        kind: "model-call",
        file: "mastra/src/capability/summarize/summarize.ts",
        startLine: 3,
        endLine: 3,
        excerpt: "ctx.generate('a')",
      },
    ]);
  });

  it("propagates a failing search instead of returning an empty success", async () => {
    const root = await fixture();
    await expect(
      collectFailureEvidence(root, { error: failure, maxTokens: 1000 }, async () => {
        throw new Error("search broke");
      }),
    ).rejects.toThrow("search broke");
  });
});

describe("host-owned root", () => {
  it("prefers EVIDENCE_REPOSITORY_ROOT, else the session cwd", () => {
    expect(evidenceRepositoryRoot("/cwd", { EVIDENCE_REPOSITORY_ROOT: "/repo" })).toBe("/repo");
    expect(evidenceRepositoryRoot("/cwd", { EVIDENCE_REPOSITORY_ROOT: "" })).toBe("/cwd");
    expect(evidenceRepositoryRoot("/cwd", {})).toBe("/cwd");
  });
});

describe("searchAst", () => {
  it("throws the install hint when the binary is missing", async () => {
    await expect(
      searchAst("definitely-not-an-ast-grep-binary", { path: "/tmp/x.ts", relativePath: "x.ts" }, "const $A = $B"),
    ).rejects.toThrow("ast-grep is not installed or is missing from PATH");
  });
});

/** A chainable stand-in for `pi.zod`: every method returns the same proxy. */
function fakeZod(): unknown {
  const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  return chain;
}

interface BuiltTool {
  name: string;
  description: string;
  loadMode?: unknown;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
}
const buildTool = (pi: { zod: unknown; cwd: string }): BuiltTool => (factory as unknown as (pi: unknown) => BuiltTool)(pi);

describe("tool object", () => {
  it("is named, discoverable, and rejects out-of-range input by throwing", async () => {
    const tool = buildTool({ zod: fakeZod(), cwd: "/nonexistent" });
    expect(tool.name).toBe("collect_failure_evidence");
    expect(tool.loadMode).toBeUndefined();
    const words = tool.description.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(80);
    await expect(tool.execute("id", { error: "" })).rejects.toThrow("error must be 1 to 8000");
    await expect(tool.execute("id", { error: "x", maxTokens: 10 })).rejects.toThrow("maxTokens must be");
    await expect(tool.execute("id", { error: "x", maxTokens: 2501 })).rejects.toThrow("maxTokens must be");
  });

  it("collects against pi.cwd and returns text plus typed details", async () => {
    const root = await fixture();
    const tool = buildTool({ zod: fakeZod(), cwd: root });
    const out = await tool.execute("id", { error: "unknown error", maxTokens: null });
    expect(out.details).toMatchObject({ status: "not_found", evidence: [] });
    expect(out.content[0].text).toBe("Evidence: not_found");
  });
});

const hasAstGrep = spawnSync("ast-grep", ["--version"], { encoding: "utf8" }).status === 0;

// The real binary is an environment prerequisite of the tool, so this integration run is conditional on it; the
// missing-binary path above is tested unconditionally.
describe.skipIf(!hasAstGrep)("ast-grep integration", () => {
  it("retrieves the field, incompatible schema, and return expression", async () => {
    const root = await fixture();
    const result = await collectFailureEvidence(root, { error: failure, maxTokens: 1500 });
    expect(result.status).toBe("found");
    expect(result.evidence.some((item) => item.kind === "output-field" && item.excerpt.includes("focus:"))).toBe(true);
    expect(result.evidence.some((item) => item.kind === "model-contract" && item.excerpt.includes("SUMMARY_SCHEMA"))).toBe(true);
    expect(result.evidence.some((item) => item.kind === "return-value" && item.excerpt.includes("raw_output"))).toBe(true);
  });

  it("returns no evidence for a file with no matches", async () => {
    const root = await fixture();
    await writeFile(join(root, "mastra/src/capability/summarize/summarize.ts"), "export const nothing = 1;\n");
    const result = await collectFailureEvidence(root, { error: "capability failed: summarize", maxTokens: 1500 });
    expect(result.evidence.filter((item) => item.kind === "model-call")).toEqual([]);
  });
});
