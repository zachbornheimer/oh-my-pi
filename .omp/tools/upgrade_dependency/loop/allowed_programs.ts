/**
 * The only programs the loop starts. `startAllowedProgram` switches over `AllowedProgram` with a literal at every
 * spawn site, so a program name that arrives as data can never become an arbitrary executable. The loop directory
 * imports nothing from outside itself, so `lib/allowed_programs.ts` keeps its own copy of the same list.
 * `node` is the fixture child the real-process tests run.
 */
export const ALLOWED_PROGRAMS = ["git", "gh", "omp", "aube", "pnpm", "npm", "go", "mise", "which", "rg", "node"] as const;

export type AllowedProgram = (typeof ALLOWED_PROGRAMS)[number];

export function isAllowedProgram(name: string): name is AllowedProgram {
  return (ALLOWED_PROGRAMS as readonly string[]).includes(name);
}
