import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The managed-skill store behind `manage_skill`: where managed skills live, how a name and a description
 * are normalized, and how a skill file is written and removed without following a symlink out of the root.
 * Every failure is a returned error message, never a throw.
 */

export const MANAGED_SKILLS_ROOT_ENV = "MANAGED_SKILLS_ROOT";
export const SKILLS_ROOT_ENV = "SKILLS_ROOT";
export const SKILL_FILE = "SKILL.md";
/** Cap on the final `SKILL.md`, generated frontmatter included, in UTF-8 bytes. */
export const MAX_SKILL_BYTES = 64_000;
export const MANAGED_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function managedSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[MANAGED_SKILLS_ROOT_ENV]?.trim();
  return configured || join(homedir(), ".agents", "managed-skills");
}

/** The authored library, only read here to refuse shadowing: `$SKILLS_ROOT`, else `~/.agents/skills`. */
export function authoredSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SKILLS_ROOT_ENV]?.trim();
  return configured || join(homedir(), ".agents", "skills");
}

export function normalizeSkillName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().toLowerCase();
  if (!MANAGED_SKILL_NAME.test(name)) {
    return {
      error: `Invalid skill name "${raw}": it must be 1 to 64 characters of [a-z0-9-] after trimming and lowercasing, starting with a letter or digit.`,
    };
  }
  return { name };
}

/** One line; no control or format characters, angle brackets, backticks or repeated tildes. */
export function sanitizeDescription(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\n\t]/g, " ")
    .replace(/\p{Cc}|\p{Cf}/gu, "")
    .replace(/[<>`]/g, "")
    .replace(/~{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A one-line plain scalar that YAML reads back unchanged: no `: `, ` #`, leading indicator, or bare-keyword look. */
function needsYamlQuoting(text: string): boolean {
  return (
    /: |:$| #|^[-?:,[\]{}#&*!|>'"%@]/.test(text) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(text) ||
    /^[-+]?[0-9.][0-9._eE+-]*$/.test(text)
  );
}

/** The final `SKILL.md`: frontmatter with the normalized name and the sanitized description (single-quoted only when plain YAML would misread it), then the body. */
export function managedSkillFile(name: string, description: string, body: string): string {
  const value = needsYamlQuoting(description) ? `'${description.replace(/'/g, "''")}'` : description;
  return `---\nname: ${name}\ndescription: ${value}\n---\n\n${body}`;
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function lstatSafe(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function realDirectory(path: string): Promise<Stats | undefined> {
  const stats = await lstatSafe(path);
  return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink() ? stats : undefined;
}

export async function authoredSkillExists(root: string, name: string): Promise<boolean> {
  try {
    return (await stat(join(root, name, SKILL_FILE))).isFile();
  } catch {
    return false;
  }
}

export type ManagedWriteResult = { path: string } | { error: string };

/**
 * Writes `<root>/<name>/SKILL.md`. `create` is exclusive; `update` overwrites an existing regular,
 * singly-linked file. Root, skill directory and file must be real (never followed through a symlink)
 * and every resolved path must stay inside the root.
 */
export async function writeManagedSkill(
  root: string,
  name: string,
  content: string,
  mode: "create" | "update",
): Promise<ManagedWriteResult> {
  if (mode === "update") {
    if ((await realDirectory(root)) === undefined) return { error: `Managed skill "${name}" does not exist.` };
  } else {
    try {
      await mkdir(root, { recursive: true });
    } catch (error) {
      return { error: `could not create the managed skills root "${root}": ${cause(error)}` };
    }
    if ((await realDirectory(root)) === undefined) {
      return { error: `the managed skills root "${root}" is not a real directory (symlink or file)` };
    }
  }
  const base = resolve(root);
  const directory = resolve(join(base, name));
  if (escapes(base, directory)) return { error: `skill "${name}" resolves outside the managed skills root` };
  const file = join(directory, SKILL_FILE);
  if (mode === "create") {
    if ((await lstatSafe(directory)) !== undefined) return { error: `Managed skill "${name}" already exists.` };
    try {
      await mkdir(directory);
    } catch (error) {
      return { error: `could not create managed skill "${name}": ${cause(error)}` };
    }
    let handle;
    try {
      handle = await open(file, "wx");
    } catch {
      return { error: `Managed skill "${name}" already exists.` };
    }
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return { path: file };
  }
  if ((await realDirectory(directory)) === undefined) {
    return {
      error:
        (await lstatSafe(directory)) !== undefined
          ? `Managed skill "${name}" is not a real directory.`
          : `Managed skill "${name}" does not exist.`,
    };
  }
  const fileStats = await lstatSafe(file);
  if (fileStats === undefined) return { error: `Managed skill "${name}" has no readable ${SKILL_FILE}.` };
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    return { error: `Managed skill "${name}" ${SKILL_FILE} is not a regular file.` };
  }
  if (fileStats.nlink > 1) {
    return { error: `Managed skill "${name}" ${SKILL_FILE} is hard-linked ${fileStats.nlink} times.` };
  }
  if ((await realpath(file)) !== join(await realpath(directory), SKILL_FILE)) {
    return { error: `Managed skill "${name}" ${SKILL_FILE} resolves outside the managed skills root.` };
  }
  try {
    await writeFile(file, content, "utf8");
  } catch (error) {
    return { error: `could not update managed skill "${name}": ${cause(error)}` };
  }
  return { path: file };
}

/** Recursively removes `<root>/<name>`; a missing or symlinked skill directory is an error. */
export async function deleteManagedSkill(root: string, name: string): Promise<ManagedWriteResult> {
  if ((await realDirectory(root)) === undefined) return { error: `Managed skill "${name}" does not exist.` };
  const base = resolve(root);
  const directory = resolve(join(base, name));
  if (escapes(base, directory)) return { error: `skill "${name}" resolves outside the managed skills root` };
  if ((await realDirectory(directory)) === undefined) {
    return {
      error:
        (await lstatSafe(directory)) !== undefined
          ? `Managed skill "${name}" is not a real directory.`
          : `Managed skill "${name}" does not exist.`,
    };
  }
  const rootReal = await realpath(base);
  if ((await realpath(directory)) !== resolve(join(rootReal, name))) {
    return { error: `Managed skill "${name}" resolves outside the managed skills root.` };
  }
  try {
    await rm(directory, { recursive: true });
  } catch (error) {
    return { error: `could not delete managed skill "${name}": ${cause(error)}` };
  }
  return { path: directory };
}
