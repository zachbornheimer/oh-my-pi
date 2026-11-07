/**
 * The only programs this tool starts. Each real process launcher switches over `AllowedProgram` with a literal at every
 * spawn site, so a program name that arrives as data can never become an arbitrary executable.
 * `node` is the fixture child the real-process tests run.
 */
export const ALLOWED_PROGRAMS = ["git", "gh", "omp", "aube", "pnpm", "npm", "go", "mise", "which", "rg", "node"] as const;

export type AllowedProgram = (typeof ALLOWED_PROGRAMS)[number];

export function isAllowedProgram(name: string): name is AllowedProgram {
  return (ALLOWED_PROGRAMS as readonly string[]).includes(name);
}
