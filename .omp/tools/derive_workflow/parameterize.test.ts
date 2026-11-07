import { describe, expect, it } from "bun:test";
import { parameterize, placeholdersIn, sourcePattern } from "./parameterize.ts";

describe("parameterize a transcript", () => {
  const runs = [
    "/Users/someone/src/app/scripts/deploy.sh shop.example.com --prod",
    "curl -fsS https://shop.example.com/health",
    "scripts/smoke.sh shop.example.com",
    undefined,
    "mise run build",
  ];
  const result = parameterize(runs, "transcript");

  it("turns the home directory and a hostname that repeats into inputs", () => {
    expect(result.runs).toEqual([
      "{home}/src/app/scripts/deploy.sh {host} --prod",
      "curl -fsS https://{host}/health",
      "scripts/smoke.sh {host}",
      undefined,
      "mise run build",
    ]);
    expect(result.parameters).toEqual([
      { name: "home", example: "/Users/someone" },
      { name: "host", example: "shop.example.com" },
    ]);
  });

  it("keeps the literals so the rendering is reversible", () => {
    expect(result.literals).toEqual({ home: "/Users/someone", host: "shop.example.com" });
    const restored = result.runs[0]!.replace("{home}", result.literals.home!).replace("{host}", result.literals.host!);
    expect(restored).toBe(runs[0]);
  });

  it("leaves a hostname that appears in one step alone", () => {
    expect(parameterize(["ping a.example.com", "ls"], "transcript").runs).toEqual(["ping a.example.com", "ls"]);
  });

  it("names a second host and an id that repeats", () => {
    const found = parameterize(
      ["x a.example.com b.example.org at-91chk1ab", "y a.example.com b.example.org at-91chk1ab"],
      "transcript",
    );
    expect(found.runs[0]).toBe("x {host} {host_2} {id}");
    expect(found.parameters.map((parameter) => parameter.name)).toEqual(["host", "host_2", "id"]);
  });

  it("makes a bare argument that three commands share an input", () => {
    const found = parameterize(["webmaster check bpp", "webmaster report bpp", "webmaster fix bpp"], "transcript");
    expect(found.runs).toEqual(["webmaster check {target}", "webmaster report {target}", "webmaster fix {target}"]);
  });
});

describe("parameterize a document", () => {
  it("turns <site> placeholders into inputs without examples", () => {
    const found = parameterize(["webmaster plan <site> tickets <file.json>", undefined], "document");
    expect(found.runs).toEqual(["webmaster plan {site} tickets {file_json}", undefined]);
    expect(found.parameters).toEqual([{ name: "site" }, { name: "file_json" }]);
    expect(found.literals).toEqual({ site: "<site>", file_json: "<file.json>" });
  });
});

describe("placeholders", () => {
  const declared = new Set(["site"]);

  it("finds only declared inputs", () => {
    expect(placeholdersIn("a {site} {other} ${HOME} {site}", declared)).toEqual(["site"]);
  });

  it("matches the source text modulo placeholders", () => {
    const pattern = sourcePattern("webmaster fix {site} --dry-run", declared);
    expect(pattern.test("1. `webmaster fix <site> --dry-run`. Writes")).toBe(true);
    expect(pattern.test("webmaster fix --dry-run")).toBe(false);
  });

  it("treats an undeclared {name} and regex characters literally", () => {
    expect(sourcePattern("a.b {x}", declared).test("a.b {x}")).toBe(true);
    expect(sourcePattern("a.b", declared).test("aXb")).toBe(false);
  });
});
