import type { FactoryPorts } from "./ports.js";

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
  ports: Pick<FactoryPorts, "sleep">,
  visible: () => Promise<string | undefined>,
): Promise<void> {
  let reason = "no read-back was taken";
  for (let attempt = 1; attempt <= READ_BACK_ATTEMPTS; attempt++) {
    reason = (await visible()) ?? "";
    if (reason === "") return;
    if (attempt < READ_BACK_ATTEMPTS) await ports.sleep(READ_BACK_INTERVAL_MS);
  }
  throw new Error(reason);
}
