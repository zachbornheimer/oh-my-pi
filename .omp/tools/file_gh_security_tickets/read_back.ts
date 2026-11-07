/**
 * How many times a write's read-back is re-read, and how long between reads. Linear answers a read from a lagging replica:
 * a live run on SAH-11420 saved its description and the next read still carried the old one, so one read is not proof.
 * At a 1.25 s interval a write that never lands still fails inside fifteen seconds.
 */
export const READ_BACK_ATTEMPTS = 12;
export const READ_BACK_INTERVAL_MS = 1_250;

/**
 * Re-reads until the write is visible (`visible` answers undefined) and throws its last reason when it never is. The one
 * owner of the policy: every read-back a Linear write needs goes through here.
 */
export async function readBack(
  sleep: (ms: number) => Promise<void>,
  visible: () => Promise<string | undefined>,
): Promise<void> {
  let reason = "no read-back was taken";
  for (let attempt = 1; attempt <= READ_BACK_ATTEMPTS; attempt++) {
    reason = (await visible()) ?? "";
    if (reason === "") return;
    if (attempt < READ_BACK_ATTEMPTS) await sleep(READ_BACK_INTERVAL_MS);
  }
  throw new Error(reason);
}

/**
 * A body reduced to what a reader sees of it, so a stored body can be compared with the one written: Linear rewrites
 * markdown on save (autolinks, `<tag>` chips, relative links). `org/repo#123` is normalised to `#123`, markdown link
 * targets are dropped, and everything but letters and digits goes.
 */
export function readerWords(text: string): string {
  return text
    .replace(/<([A-Za-z][\w-]*)((?:\s[^>\n]*?)?)\s*\/>/g, (_tag, _name: string, attrs: string) =>
      /(?:^|\s)label="([^"]*)"/.exec(attrs)?.[1] ?? "")
    .replace(/<([A-Za-z][\w-]*)(?:\s[^>\n]*)?>([^<\n]*?)<\/\1>/g, "$2")
    .replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)\b/g, "#$1")
    .replace(/\]\(\s*<[^>\n]*>\s*\)|\]\([^)\n]*\)/g, "]")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a stored body is the body that was written, by what a reader sees of each. */
export function sameWords(left: string, right: string): boolean {
  return readerWords(left) === readerWords(right);
}
