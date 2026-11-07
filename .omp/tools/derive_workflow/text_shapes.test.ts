import { describe, expect, it } from "bun:test";
import { isProgramWord } from "./document_candidates.ts";
import { hostnamesIn } from "./parameterize.ts";
import { isWorkflowName } from "./schemas.ts";

describe("isWorkflowName: lower-case words joined by single hyphens, starting with a letter", () => {
  it.each(["webmaster", "new-site", "a", "a1-b2-3", "x-1"])("accepts %p", (name) => {
    expect(isWorkflowName(name)).toBe(true);
  });
  it.each(["", "-a", "a-", "a--b", "1a", "A", "a_b", "a-B", "a b", "a-\n", "a\n"])("rejects %p", (name) => {
    expect(isWorkflowName(name)).toBe(false);
  });
});

describe("isProgramWord: a bare program name or a path to a script", () => {
  it.each(["deploy", "./run.sh", "../bin/x", "~/bin/tool", "/usr/bin/env", "scripts/smoke.sh", "a-b.c_d/e.f"])(
    "accepts %p",
    (word) => {
      expect(isProgramWord(word)).toBe(true);
    },
  );
  it.each(["", "-f", "--flag", "/cmd/", "//x", "<site>", "1abc", "./", "a//b", "a/", ".../x", "~x/y", "a b"])(
    "rejects %p",
    (word) => {
      expect(isProgramWord(word)).toBe(false);
    },
  );
});

describe("hostnamesIn: dotted labels ending in a known suffix", () => {
  it("finds hostnames left to right", () => {
    expect(hostnamesIn("curl https://shop.example.com/health and api.dev.local")).toEqual([
      "shop.example.com",
      "api.dev.local",
    ]);
  });
  it("prefers the longest run of labels that ends in a suffix", () => {
    expect(hostnamesIn("foo.com.au")).toEqual(["foo.com"]);
    expect(hostnamesIn("a.b.co")).toEqual(["a.b.co"]);
  });
  it("needs a word boundary on both ends and a known suffix", () => {
    expect(hostnamesIn("x_a.com")).toEqual([]);
    expect(hostnamesIn("a.company")).toEqual([]);
    expect(hostnamesIn("a..com")).toEqual([]);
    expect(hostnamesIn("file.json")).toEqual([]);
    expect(hostnamesIn("")).toEqual([]);
  });
});
