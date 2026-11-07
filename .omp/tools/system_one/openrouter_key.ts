import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_KEY_REFERENCE = "op://Zysys/OpenRouter API Key/credential";

/** Runs `op read <reference>` and returns its stdout; replaced by a fake in tests. */
export type OpRead = (reference: string, env: NodeJS.ProcessEnv) => Promise<string>;

const realOpRead: OpRead = (reference, env) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("op", ["read", reference], { env, timeout: 20_000, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error === null) resolve(stdout);
    else reject(new Error((stderr.trim() || `op exited ${error.code ?? error.message}`).split("\n")[0] ?? ""));
  });
  return promise;
};

/** How long a failed `op read` is remembered, so a signed-out 1Password is not asked again on every call. */
export const FAILURE_MEMORY_MS = 300_000;

let cachedKey: string | undefined;
let cachedFailure: { message: string; at: number } | undefined;

/** Drops the process-wide `op read` result and failure; tests use it. */
export function resetCachedKey(): void {
  cachedKey = undefined;
  cachedFailure = undefined;
}

/**
 * The OpenRouter key: from the environment, else 1Password (`OPENROUTER_API_KEY=op://...` names the item, otherwise
 * the default reference; the service-account token file is loaded when present). Throws when neither yields a key.
 */
export async function openRouterKey(env: NodeJS.ProcessEnv = process.env, opRead: OpRead = realOpRead): Promise<string> {
  const fromEnv = env[OPENROUTER_KEY_ENV]?.trim();
  if (fromEnv && !fromEnv.startsWith("op://")) return fromEnv;
  if (cachedKey) return cachedKey;
  if (cachedFailure && Date.now() - cachedFailure.at < FAILURE_MEMORY_MS) throw new Error(cachedFailure.message);
  const reference = fromEnv && fromEnv.startsWith("op://") ? fromEnv : OPENROUTER_KEY_REFERENCE;
  const home = homedir();
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${join(home, ".local", "share", "mise", "shims")}:${join(home, ".local", "bin")}:${env.PATH ?? "/usr/bin:/bin"}`,
  };
  if (!childEnv.OP_SERVICE_ACCOUNT_TOKEN) {
    const tokenFile = join(home, ".config", "dev-env", "secrets", "op-service-account-token");
    if (existsSync(tokenFile)) {
      try {
        childEnv.OP_SERVICE_ACCOUNT_TOKEN = readFileSync(tokenFile, "utf8").trim();
      } catch {
        // Fall through to op's own error.
      }
    }
  }
  try {
    const key = (await opRead(reference, childEnv)).trim();
    if (key === "") throw new Error("1Password returned an empty value");
    cachedKey = key;
    return key;
  } catch (error) {
    const message = `OpenRouter key unavailable: set ${OPENROUTER_KEY_ENV} or sign in to 1Password for ${OPENROUTER_KEY_REFERENCE} (${(error as Error).message})`;
    cachedFailure = { message, at: Date.now() };
    throw new Error(message);
  }
}
