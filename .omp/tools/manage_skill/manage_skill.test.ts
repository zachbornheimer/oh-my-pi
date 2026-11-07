import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { frontMatterFieldsForTest } from "./test_support.js";
import { managedSkillFile } from "./managed.js";

const chain: any = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const tool: any = await factory({ zod: chain } as any);
const run = (params: any) => tool.execute("id", params, undefined, undefined, undefined);

let managed = "";
let authored = "";
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  managed = await mkdtemp(join(tmpdir(), "managed-"));
  authored = await mkdtemp(join(tmpdir(), "authored-"));
  for (const k of ["MANAGED_SKILLS_ROOT", "SKILLS_ROOT"]) saved[k] = process.env[k];
  process.env.MANAGED_SKILLS_ROOT = managed;
  process.env.SKILLS_ROOT = authored;
});
afterEach(async () => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(managed, { recursive: true, force: true });
  await rm(authored, { recursive: true, force: true });
});
const file = (n: string) => join(managed, n, "SKILL.md");
const exists = (p: string) => stat(p).then(() => true, () => false);
const create = (over: any = {}) => run({ action: "create", name: "demo", description: "Demo skill.", body: "# Demo", ...over });

describe("manage_skill create", () => {
  it("writes frontmatter then the trimmed body", async () => {
    const out = await create({ body: "\n# Demo\n\nText\n\n" });
    expect(out.details).toEqual({ action: "create", name: "demo", path: file("demo"), created: true });
    expect(await readFile(file("demo"), "utf8")).toBe("---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo\n\nText");
  });
  it("trims and lowercases the name", async () => {
    expect((await create({ name: "  Demo-One " })).details.name).toBe("demo-one");
    expect(await exists(file("demo-one"))).toBe(true);
  });
  it("is exclusive and leaves the first file", async () => {
    await create();
    await expect(create({ body: "other" })).rejects.toThrow(/already exists/);
    expect(await readFile(file("demo"), "utf8")).toContain("# Demo");
  });
  it("refuses a name an authored skill owns, writing nothing", async () => {
    await mkdir(join(authored, "demo"));
    await writeFile(join(authored, "demo", "SKILL.md"), "---\ndescription: x\n---\n");
    await expect(create()).rejects.toThrow(/authored skill named "demo"/);
    expect(await exists(join(managed, "demo"))).toBe(false);
  });
  it("refuses unsafe names", async () => {
    for (const name of ["", "  ", "../x", "a/b", ".hidden", "-x", "a".repeat(65), "naïve"]) {
      await expect(create({ name })).rejects.toThrow(/Invalid skill name/);
    }
    expect((await create({ name: "a".repeat(64) })).details.created).toBe(true);
  });
  it("requires description and body, including null", async () => {
    await expect(create({ description: undefined })).rejects.toThrow(/requires both/);
    await expect(create({ body: null })).rejects.toThrow(/requires both/);
    await expect(create({ description: " <>`` " })).rejects.toThrow(/non-empty description/);
    await expect(create({ body: " \n " })).rejects.toThrow(/non-empty body/);
  });
  it("sanitizes the description to one line", async () => {
    await create({ description: "Line one\r\nline\ttwo <b>`x`</b> ~~gone~~ \u200bz" });
    const text = await readFile(file("demo"), "utf8");
    expect(text.split("\n")[2]).toBe("description: Line one line two bx/b gone z");
  });
  it("quotes a description YAML would misread (FIXED: `a: b` produced broken frontmatter) and it reads back", async () => {
    for (const d of ["Use when: reviewing", "# not a comment", "true", "42", "- dash", "it's: odd"]) {
      await rm(join(managed, "demo"), { recursive: true, force: true });
      await create({ description: d });
      expect(frontMatterFieldsForTest(await readFile(file("demo"), "utf8")).description).toBe(
        d.includes("'") ? d.replace(/'/g, "''") : d,
      );
    }
    expect(managedSkillFile("n", "plain words", "b")).toContain("description: plain words\n");
  });
  it("refuses a body starting with frontmatter", async () => {
    await expect(create({ body: "---\nname: x\n---\nhi" })).rejects.toThrow(/frontmatter/);
    expect((await create({ body: "text\n---\nmore" })).details.created).toBe(true);
  });
  it("caps the final file at 64000 bytes exactly", async () => {
    const head = managedSkillFile("demo", "Demo skill.", "").length;
    const ok = await create({ body: "x".repeat(64_000 - head) });
    expect(ok.details.created).toBe(true);
    await rm(join(managed, "demo"), { recursive: true });
    await expect(create({ body: "x".repeat(64_001 - head) })).rejects.toThrow(/64001 bytes; the limit is 64000/);
    expect(await exists(join(managed, "demo"))).toBe(false);
  });
  it("counts bytes, not characters", async () => {
    await expect(create({ body: "é".repeat(32_000) })).rejects.toThrow(/limit is 64000/);
  });
  it("refuses a symlinked directory at the skill path and a symlinked root", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
    await symlink(elsewhere, join(managed, "demo"));
    await expect(create()).rejects.toThrow(/already exists/);
    expect(await exists(join(elsewhere, "SKILL.md"))).toBe(false);
    const linkedRoot = join(elsewhere, "root-link");
    await symlink(managed, linkedRoot);
    process.env.MANAGED_SKILLS_ROOT = linkedRoot;
    await expect(create({ name: "other" })).rejects.toThrow(/not a real directory/);
    await rm(elsewhere, { recursive: true, force: true });
  });
  it("creates a missing root", async () => {
    process.env.MANAGED_SKILLS_ROOT = join(managed, "nested", "root");
    expect((await create()).details.created).toBe(true);
  });
});

describe("manage_skill update", () => {
  it("overwrites an existing managed skill without `created`", async () => {
    await create();
    const out = await run({ action: "update", name: "demo", description: "New.", body: "new body" });
    expect(out.details).toEqual({ action: "update", name: "demo", path: file("demo") });
    expect(await readFile(file("demo"), "utf8")).toBe("---\nname: demo\ndescription: New.\n---\n\nnew body");
  });
  it("fails for a missing skill, a missing root, or a directory without SKILL.md", async () => {
    await expect(run({ action: "update", name: "ghost", description: "d", body: "b" })).rejects.toThrow(/does not exist/);
    await mkdir(join(managed, "bare"));
    await expect(run({ action: "update", name: "bare", description: "d", body: "b" })).rejects.toThrow(/no readable/);
    process.env.MANAGED_SKILLS_ROOT = join(managed, "nope");
    await expect(run({ action: "update", name: "x", description: "d", body: "b" })).rejects.toThrow(/does not exist/);
  });
  it("update may overwrite a name an authored skill owns only if the managed one exists; no shadow check on update", async () => {
    await create();
    await mkdir(join(authored, "demo"));
    await writeFile(join(authored, "demo", "SKILL.md"), "x");
    expect((await run({ action: "update", name: "demo", description: "d", body: "b" })).details.action).toBe("update");
  });
  it("refuses a symlinked target and a multiply hard-linked target, leaving the other file intact", async () => {
    const outside = join(managed, "..", `outside-${Date.now()}.md`);
    await writeFile(outside, "keep");
    await mkdir(join(managed, "sym"));
    await symlink(outside, file("sym"));
    await expect(run({ action: "update", name: "sym", description: "d", body: "b" })).rejects.toThrow(/not a regular file/);
    await mkdir(join(managed, "hard"));
    await link(outside, file("hard"));
    await expect(run({ action: "update", name: "hard", description: "d", body: "b" })).rejects.toThrow(/hard-linked/);
    expect(await readFile(outside, "utf8")).toBe("keep");
    await rm(outside);
  });
  it("refuses a symlinked skill directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
    await writeFile(join(elsewhere, "SKILL.md"), "keep");
    await symlink(elsewhere, join(managed, "linked"));
    await expect(run({ action: "update", name: "linked", description: "d", body: "b" })).rejects.toThrow(/not a real directory/);
    expect(await readFile(join(elsewhere, "SKILL.md"), "utf8")).toBe("keep");
    await rm(elsewhere, { recursive: true, force: true });
  });
  it("works when the root sits under a symlinked parent such as macOS /var (FIXED: realpath compare broke)", async () => {
    await create();
    expect((await run({ action: "update", name: "demo", description: "d", body: "b" })).details.action).toBe("update");
  });
});

describe("manage_skill delete", () => {
  it("recursively removes the skill directory", async () => {
    await create();
    await mkdir(join(managed, "demo", "references"));
    await writeFile(join(managed, "demo", "references", "r.md"), "r");
    const out = await run({ action: "delete", name: "demo" });
    expect(out.details).toEqual({ action: "delete", name: "demo", path: join(managed, "demo") });
    expect(await exists(join(managed, "demo"))).toBe(false);
  });
  it("needs no description or body, and fails for a missing skill", async () => {
    await expect(run({ action: "delete", name: "ghost" })).rejects.toThrow(/does not exist/);
    process.env.MANAGED_SKILLS_ROOT = join(managed, "nope");
    await expect(run({ action: "delete", name: "ghost" })).rejects.toThrow(/does not exist/);
  });
  it("refuses a symlinked skill directory and keeps its target", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
    await writeFile(join(elsewhere, "SKILL.md"), "keep");
    await symlink(elsewhere, join(managed, "linked"));
    await expect(run({ action: "delete", name: "linked" })).rejects.toThrow(/not a real directory/);
    expect(await exists(join(elsewhere, "SKILL.md"))).toBe(true);
    await rm(elsewhere, { recursive: true, force: true });
  });
  it("never touches the authored library", async () => {
    await mkdir(join(authored, "demo"));
    await writeFile(join(authored, "demo", "SKILL.md"), "x");
    await expect(run({ action: "delete", name: "demo" })).rejects.toThrow(/does not exist/);
    expect(await exists(join(authored, "demo", "SKILL.md"))).toBe(true);
  });
  it("refuses traversal names before touching disk", async () => {
    await expect(run({ action: "delete", name: ".." })).rejects.toThrow(/Invalid skill name/);
  });
});
