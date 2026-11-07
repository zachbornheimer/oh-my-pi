import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";

const chain: any = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const tool: any = await factory({ zod: chain } as any);
const run = (params: any) => tool.execute("id", params, undefined, undefined, undefined);

let root = "";
let prev: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-"));
  prev = process.env.SKILLS_ROOT;
  process.env.SKILLS_ROOT = root;
  await mkdir(join(root, "code-style", "references"), { recursive: true });
  await writeFile(join(root, "code-style", "SKILL.md"), "# Code style\n");
  await writeFile(join(root, "code-style", "references", "x.md"), "ref x\n");
  await writeFile(join(root, "secret.txt"), "outside the skill\n");
});
afterEach(async () => {
  if (prev === undefined) delete process.env.SKILLS_ROOT;
  else process.env.SKILLS_ROOT = prev;
  await rm(root, { recursive: true, force: true });
});

describe("read_skill", () => {
  it("reads SKILL.md by bare name", async () => {
    const out = await run({ name: "code-style" });
    expect(out.content[0].text).toBe("# Code style\n");
    expect(out.details).toEqual({ name: "code-style", path: join(root, "code-style", "SKILL.md"), content: "# Code style\n" });
  });
  it("reads a file by path, by skill:// subpath, and treats null/blank path as SKILL.md", async () => {
    expect((await run({ name: "code-style", path: "references/x.md" })).content[0].text).toBe("ref x\n");
    expect((await run({ name: "skill://code-style/references/x.md" })).content[0].text).toBe("ref x\n");
    expect((await run({ name: "skill://code-style" })).content[0].text).toBe("# Code style\n");
    expect((await run({ name: "code-style", path: null })).content[0].text).toBe("# Code style\n");
    expect((await run({ name: "code-style", path: " " })).content[0].text).toBe("# Code style\n");
  });
  it("path wins over a skill:// subpath", async () => {
    expect((await run({ name: "skill://code-style/nope.md", path: "references/x.md" })).content[0].text).toBe("ref x\n");
  });
  it("refuses a path leaving the skill directory", async () => {
    await expect(run({ name: "code-style", path: "../../secret.txt" })).rejects.toThrow(/outside/);
    await expect(run({ name: "code-style", path: "../secret.txt" })).rejects.toThrow(/outside the skill directory/);
    await expect(run({ name: "skill://code-style/../../secret.txt" })).rejects.toThrow(/outside/);
  });
  it("refuses a name leaving the root, and . / .. names (FIXED: `.` read the root's own SKILL.md)", async () => {
    await expect(run({ name: "../x" })).rejects.toThrow(/not a skill name/);
    await expect(run({ name: ".." })).rejects.toThrow(/not a skill name/);
    await writeFile(join(root, "SKILL.md"), "root skill");
    await expect(run({ name: "." })).rejects.toThrow(/not a skill name/);
    await expect(run({ name: "skill://." })).rejects.toThrow(/not a skill name/);
  });
  it("allows a file whose name merely starts with two dots (FIXED: prefix test refused it)", async () => {
    await writeFile(join(root, "code-style", "..notes.md"), "dots");
    expect((await run({ name: "code-style", path: "..notes.md" })).content[0].text).toBe("dots");
  });
  it("refuses an empty name, a missing skill and a missing file", async () => {
    await expect(run({ name: "" })).rejects.toThrow(/empty/);
    await expect(run({ name: "skill://" })).rejects.toThrow(/empty/);
    await expect(run({ name: "nope" })).rejects.toThrow(/no readable SKILL.md/);
    await expect(run({ name: "code-style", path: "references/none.md" })).rejects.toThrow(/no readable references\/none.md/);
    await expect(run({ name: "code-style", path: "references" })).rejects.toThrow(/no readable/);
  });
  it("reads through a symlinked skill directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "linked-"));
    await writeFile(join(elsewhere, "SKILL.md"), "linked body");
    await symlink(elsewhere, join(root, "linked"));
    expect((await run({ name: "linked" })).content[0].text).toBe("linked body");
    await rm(elsewhere, { recursive: true, force: true });
  });
  it("respects the SKILLS_ROOT override", async () => {
    const other = await mkdtemp(join(tmpdir(), "other-"));
    process.env.SKILLS_ROOT = other;
    await expect(run({ name: "code-style" })).rejects.toThrow(/no readable/);
    await rm(other, { recursive: true, force: true });
  });
});
