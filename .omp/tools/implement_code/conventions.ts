/** The repo's conventions as data, read from the repo before the model steps run (see gather/read_conventions.ts). */

/** A file's text, cut when it was too long to keep whole. */
export interface Excerpt {
  /** Path relative to the repo. */
  path: string;
  text: string;
  /** True when `text` was cut and is only part of the file. */
  truncated: boolean;
  /** sha256 of the whole file; set when `text` is the file itself, so an edit can be refused if the file moved on. */
  sha256?: string;
}

/** A file that lists modules by name; its hash is always set. */
export interface Registry extends Excerpt {
  sha256: string;
}

/** The closest existing thing to the design: a directory of files or one file, with the tests that cover it. */
export interface Sibling {
  name: string;
  files: Excerpt[];
  tests: Excerpt[];
  /** Files from the test tree that the tests import (fakes, fixtures, harnesses). */
  support: Excerpt[];
}

export const TEST_LAYOUTS = ["separate_tree", "beside_code", "unknown"] as const;
export const NAMINGS = ["snake_case", "kebab-case", "camelCase", "PascalCase", "unknown"] as const;

export interface Style {
  test_layout: (typeof TEST_LAYOUTS)[number];
  /** Where separate-tree tests live; empty otherwise. */
  test_root: string;
  naming: (typeof NAMINGS)[number];
  named_exports_only: boolean;
  config: Excerpt[];
}

export interface Layout {
  top_level: string[];
  home: string;
  home_entries: string[];
  near: { directory: string; entries: string[] }[];
  /** Every file of the repo (repo-relative). */
  known_files: string[];
  /** True when `known_files` was cut at the limit. */
  truncated: boolean;
}

/** Where a name the design replaces is still used. */
export interface Usage {
  name: string;
  files: string[];
}

export interface Conventions {
  /** `typescript`, `go`, `python` ... or `unknown`. */
  language: string;
  layout: Layout;
  siblings: Sibling[];
  registries: Registry[];
  style: Style;
  guidance: Excerpt[];
  usages: Usage[];
}
