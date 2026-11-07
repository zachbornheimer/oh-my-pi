import { createHash } from "node:crypto";

/** The sha256 of `text` as hex: how a file is recognised as unchanged between the host's read and its write. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
