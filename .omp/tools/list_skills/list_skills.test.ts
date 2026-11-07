import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
afterEach(async () => {
  if (prev === undefined) delete process.env.SKILLS_ROOT;
  else process.env.SKILLS_ROOT = prev;
  await rm(root, { recursive: true, force: true });
});
async function many(n: number) {
  for (let i = 0; i < n; i++) {
    const name = `s${String(i).padStart(2, "0")}`;
    await mkdir(join(root, name));
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription:   spaced\n   out  ${i}\n---\n`);
  }
}

describe("list_skills", () => {
  it("returns at most 20 sorted per call and pages with next_offset", async () => {
    await many(25);
    const first = await run({});
    expect(first.details.skills.length).toBe(20);
    expect(first.details.total).toBe(25);
    expect(first.details.next_offset).toBe(20);
    expect(first.details.skills[0]).toEqual({ name: "s00", description: "spaced" });
    const second = await run({ offset: first.details.next_offset });
    expect(second.details.skills.map((s: any) => s.name)).toEqual(["s20", "s21", "s22", "s23", "s24"]);
    expect("next_offset" in second.details).toBe(false);
  });
  it("accepts null offset and limit, and a smaller limit", async () => {
    await many(5);
    const out = await run({ offset: null, limit: 2 });
    expect(out.details.skills.length).toBe(2);
    expect(out.details.next_offset).toBe(2);
    expect((await run({ offset: null, limit: null })).details.total).toBe(5);
  });
  it("collapses descriptions to one line", async () => {
    await mkdir(join(root, "x"));
    await writeFile(join(root, "x", "SKILL.md"), "---\nname: x\ndescription: >\n  a\n  b\n---\n");
    expect((await run({})).details.skills[0].description).toBe("a b");
  });
  it("holds the cap and refuses bad offsets", async () => {
    await expect(run({ limit: 21 })).rejects.toThrow(/1 to 20/);
    await expect(run({ limit: 0 })).rejects.toThrow(/1 to 20/);
    await expect(run({ offset: -1 })).rejects.toThrow(/0 or more/);
    await expect(run({ offset: 1.2 })).rejects.toThrow(/0 or more/);
  });
  it("ends an empty or missing root with an empty page", async () => {
    expect((await run({})).details).toEqual({ skills: [], total: 0 });
    process.env.SKILLS_ROOT = join(root, "missing");
    expect((await run({})).details).toEqual({ skills: [], total: 0 });
  });
  it("offset past the end is an empty page with the total", async () => {
    await many(3);
    expect((await run({ offset: 50 })).details).toEqual({ skills: [], total: 3 });
  });
  it("sorts by UTF-8 bytes", async () => {
    for (const n of ["b", "Z", "é", "a"]) {
      await mkdir(join(root, n));
      await writeFile(join(root, n, "SKILL.md"), "---\ndescription: d\n---\n");
    }
    expect((await run({})).details.skills.map((s: any) => s.name)).toEqual(["Z", "a", "b", "é"]);
  });
});
