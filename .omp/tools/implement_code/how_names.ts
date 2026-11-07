import { wordsOf } from "./words.js";

/** Words that name a vendor, a store or a transport: how something is done, which must not be what it is called. */
const VENDOR_WORDS = [
  "redis",
  "sqlite",
  "postgres",
  "postgresql",
  "mysql",
  "mongo",
  "mongodb",
  "dynamodb",
  "kafka",
  "rabbitmq",
  "grpc",
  "regex",
  "openai",
  "anthropic",
  "claude",
  "gpt",
  "gemini",
  "grok",
  "ollama",
  "openrouter",
  "docker",
  "kubernetes",
];

/** Words that say how a capability works instead of what it does (the ones the Mastra capability namer refuses). */
const CAPABILITY_HOW_WORDS: readonly string[] = [
  "with",
  "via",
  "using",
  "llm",
  "gpt",
  "claude",
  "openai",
  "regex",
  "sqlite",
  "redis",
  "ssh",
  "curl",
  "script",
  "cli",
];

/** Words that say how: the capability words above, and the vendors. */
const HOW_WORDS: ReadonlySet<string> = new Set([...CAPABILITY_HOW_WORDS, ...VENDOR_WORDS]);

/** Words that name no concept at all. */
const UNOWNED_WORDS = new Set([
  "utils",
  "util",
  "helpers",
  "helper",
  "manager",
  "managers",
  "service",
  "services",
  "misc",
  "stuff",
  "impl",
]);

/** Why `name` does not say what the thing is, or undefined when it does. Written for the model that chose it. */
export function nameProblem(name: string): string | undefined {
  const words = wordsOf(name);
  const how = words.find((word) => HOW_WORDS.has(word));
  if (how !== undefined) {
    return `"${name}" says how (${how}), not what: name the concept, so the name stays right if the mechanism changes`;
  }
  const unowned = words.find((word) => UNOWNED_WORDS.has(word));
  if (unowned !== undefined) return `"${name}" names no concept (${unowned}): name what the code owns`;
  return undefined;
}
