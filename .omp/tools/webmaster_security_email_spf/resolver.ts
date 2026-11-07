import { promises as dns } from "node:dns";

/** The name does not exist at all (NXDOMAIN), as opposed to existing with no record of the kind asked. */
export class NameNotFound extends Error {
  constructor(readonly name: string) {
    super(`${name} does not exist`);
    this.name = "NameNotFound";
  }
}

export interface MxRecord {
  /** The mail server's hostname. */
  exchange: string;
  /** The MX preference; lower is tried first. */
  priority: number;
}

/**
 * The lookups a check needs. Each resolves to [] when the name has no such record and rejects on a failed lookup;
 * `a` and `aaaa` reject with `NameNotFound` when the name does not exist.
 */
export interface DnsResolver {
  a(name: string): Promise<readonly string[]>;
  aaaa(name: string): Promise<readonly string[]>;
  /** The name's own CNAME target(s), one hop. */
  cname(name: string): Promise<readonly string[]>;
  mx(name: string): Promise<readonly MxRecord[]>;
  ns(name: string): Promise<readonly string[]>;
  /** The name's TXT records, each joined from its strings. */
  txt(name: string): Promise<readonly string[]>;
}

/** Milliseconds one DNS query may wait for an answer, and how many times it is sent. */
export const DNS_TIMEOUT_MS = 4_000;
export const DNS_TRIES = 2;

/** Answers that mean "this name has no such record", not "the lookup failed". */
const NO_RECORD_CODES = new Set(["ENODATA", "ENOTFOUND"]);

const codeOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error ? String(error.code) : undefined;

async function orNone<T>(lookup: Promise<T[]>): Promise<T[]> {
  try {
    return await lookup;
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && NO_RECORD_CODES.has(code)) return [];
    throw error;
  }
}

/** An address lookup: a name that does not exist is `NameNotFound`, one that exists with no address is empty. */
async function addressesOf(name: string, lookup: Promise<string[]>): Promise<string[]> {
  try {
    return await lookup;
  } catch (error) {
    if (codeOf(error) === "ENOTFOUND") throw new NameNotFound(name);
    return orNone(Promise.reject(error));
  }
}

/** A TXT character-string holds at most 255 bytes; a longer record (a DKIM key, a long SPF) is sent as several. */
const TXT_STRING_MAX = 255;
const runsOnBun = "bun" in process.versions;

/**
 * One string per TXT record. Node groups the character-strings of each record in one array and they are joined here.
 * Bun's `resolveTxt` returns each character-string as its own array, losing the record boundaries, so a record over
 * 255 bytes would arrive as several; under Bun a string of exactly 255 bytes is taken to continue into the next one.
 * (Only a record whose single string is exactly 255 bytes, followed by another record, is then joined wrongly.)
 */
export function joinTxt(answer: readonly (readonly string[])[], stringsAreSeparate: boolean = runsOnBun): string[] {
  if (!stringsAreSeparate) return answer.map((parts) => parts.join(""));
  const records: string[] = [];
  let continuing = false;
  for (const parts of answer) {
    const text = parts.join("");
    if (continuing) records[records.length - 1] += text;
    else records.push(text);
    continuing = parts.length > 0 && parts[parts.length - 1]!.length === TXT_STRING_MAX;
  }
  return records;
}

export interface SystemResolverOptions {
  /** Cancels every query still in flight. */
  readonly signal?: AbortSignal | undefined;
  /** Name servers to ask instead of the machine's own (`ip` or `ip:port`); tests point this at a local server. */
  readonly servers?: readonly string[];
  readonly timeoutMs?: number;
  readonly tries?: number;
}

/**
 * The machine's own resolver (`node:dns`), read-only. Each query is bounded by DNS_TIMEOUT_MS × DNS_TRIES unless
 * the options say otherwise.
 */
export function systemResolver(options: SystemResolverOptions = {}): DnsResolver {
  const resolver = new dns.Resolver({ timeout: options.timeoutMs ?? DNS_TIMEOUT_MS, tries: options.tries ?? DNS_TRIES });
  if (options.servers !== undefined) resolver.setServers([...options.servers]);
  options.signal?.addEventListener("abort", () => resolver.cancel(), { once: true });
  return {
    // `async` so a name the runtime refuses outright (an empty one) rejects like any failed lookup instead of throwing.
    a: async (name) => addressesOf(name, resolver.resolve4(name)),
    aaaa: async (name) => addressesOf(name, resolver.resolve6(name)),
    cname: async (name) => orNone(resolver.resolveCname(name)),
    mx: async (name) => orNone(resolver.resolveMx(name)),
    ns: async (name) => orNone(resolver.resolveNs(name)),
    txt: async (name) => joinTxt(await orNone(resolver.resolveTxt(name))),
  };
}
