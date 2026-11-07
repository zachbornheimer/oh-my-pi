import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { frontMatterFields, rankSkills, scanSkills } from "./skills_lib.js";

const chain: any = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const tool: any = await factory({ zod: chain } as any);
const run = (params: any) => tool.execute("id", params, undefined, undefined, undefined);

let root = "";
let prev: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-"));
  prev = process.env.SKILLS_ROOT;
  process.env.SKILLS_ROOT = root;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.SKILLS_ROOT;
  else process.env.SKILLS_ROOT = prev;
  await rm(root, { recursive: true, force: true });
});
async function skill(name: string, description: string, raw?: string) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), raw ?? `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

describe("find_skills", () => {
  it("ranks by keyword overlap and returns absolute SKILL.md paths", async () => {
    await skill("pr-review", "Review a pull request for bugs");
    await skill("cooking", "Bake bread and pasta");
    await skill("deploy", "Deploy services to production");
    const out = await run({ need: "review pull requests" });
    expect(out.details.matches.map((m: any) => m.name)).toEqual(["pr-review"]);
    expect(out.details.matches[0].path).toBe(join(root, "pr-review", "SKILL.md"));
    expect(JSON.parse(out.content[0].text)).toEqual(out.details);
  });
  it("is case-insensitive and drops stopwords", async () => {
    await skill("a", "Review the CODE");
    expect((await run({ need: "THE code" })).details.matches.length).toBe(1);
    expect((await run({ need: "the of and" })).details.matches).toEqual([]);
  });
  it("does not match a two-letter prefix, matches three-letter prefixes", async () => {
    await skill("a", "merge branches");
    expect((await run({ need: "me" })).details.matches).toEqual([]);
    expect((await run({ need: "mer" })).details.matches.length).toBe(1);
  });
  it("ranks rarer words higher and breaks ties by name", async () => {
    await skill("common1", "alpha");
    await skill("common2", "alpha");
    await skill("rare", "zebra alpha");
    const out = await run({ need: "alpha zebra" });
    expect(out.details.matches[0].name).toBe("rare");
    expect(out.details.matches.slice(1).map((m: any) => m.name)).toEqual(["common1", "common2"]);
  });
  it("applies limit, default 5, null limit", async () => {
    for (let i = 0; i < 7; i++) await skill(`s${i}`, "shared word");
    expect((await run({ need: "shared" })).details.matches.length).toBe(5);
    expect((await run({ need: "shared", limit: null })).details.matches.length).toBe(5);
    expect((await run({ need: "shared", limit: 2 })).details.matches.length).toBe(2);
  });
  it("refuses a blank need and out-of-range limits", async () => {
    await expect(run({ need: "  " })).rejects.toThrow(/blank/);
    await expect(run({ need: "x", limit: 0 })).rejects.toThrow(/1 to 10/);
    await expect(run({ need: "x", limit: 11 })).rejects.toThrow(/1 to 10/);
    await expect(run({ need: "x", limit: 1.5 })).rejects.toThrow(/1 to 10/);
  });
  it("returns an empty list for a missing root", async () => {
    process.env.SKILLS_ROOT = join(root, "nope");
    expect((await run({ need: "anything" })).details.matches).toEqual([]);
  });
  it("finds a skill that is a symlink to a directory (FIXED: source skipped symlinked skills)", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "linked-"));
    await writeFile(join(elsewhere, "SKILL.md"), "---\nname: linked\ndescription: linked wizardry\n---\n");
    await symlink(elsewhere, join(root, "linked"));
    expect((await run({ need: "wizardry" })).details.matches[0].name).toBe("linked");
    await rm(elsewhere, { recursive: true, force: true });
  });
  it("skips directories without SKILL.md and files", async () => {
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "file.md"), "x");
    expect(await scanSkills(root)).toEqual([]);
  });
  it("reads folded descriptions and ignores an unterminated block", async () => {
    await skill("f", "", "---\nname: f\ndescription: >\n  folded line\n  two\n---\n");
    await skill("u", "", "---\nname: u\ndescription: never closes\n");
    const skills = await scanSkills(root);
    expect(skills.find((s) => s.name === "f")?.description).toBe("folded line two");
    expect(skills.find((s) => s.name === "u")?.description).toBe("");
    expect(frontMatterFields("no front matter")).toEqual({});
    expect(rankSkills([], "x")).toEqual([]);
  });
});
