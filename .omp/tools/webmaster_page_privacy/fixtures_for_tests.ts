import { loadZod } from "./zod_for_tests.ts";

export async function makePi() {
  const zod = await loadZod();
  const exec = async () => {
    throw new Error("a test must not run a real process");
  };
  return { zod, exec, cwd: "/tmp" } as never;
}

export const texts = (result: { content: { text: string }[] }): string => result.content.map((c) => c.text).join("");
