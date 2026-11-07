import { isIP } from "node:net";
import type { AddressHolder, AddressObservation, CloudAddress } from "./types.ts";

/** True when the two holders are the same resource, by every field the reader fills. */
const sameHolder = (left: AddressHolder, right: AddressHolder): boolean =>
  left.cloud === right.cloud
  && left.kind === right.kind
  && left.profile === right.profile
  && left.account === right.account
  && left.region === right.region
  && left.resource_id === right.resource_id
  && left.resource_name === right.resource_name
  && left.state === right.state;

/** IPv4 addresses as a number, so they read in address order; every other address as text. */
function order(address: string): number | string {
  if (isIP(address) !== 4) return address;
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

/** IPv4 in numeric order first, then everything else by text: a total order, so a mixed list sorts the same every time. */
function compareAddresses(left: string, right: string): number {
  const [a, b] = [order(left), order(right)];
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One entry per address, its holders in the order the reads reported them, addresses in address order. Two reads of one
 * resource make one holder, never two.
 */
export function heldAddresses(observations: readonly AddressObservation[]): CloudAddress[] {
  const byAddress = new Map<string, CloudAddress>();
  for (const { address, ...holder } of observations) {
    const entry = byAddress.get(address);
    if (entry === undefined) byAddress.set(address, { address, holders: [holder] });
    else if (!entry.holders.some((seen) => sameHolder(seen, holder))) entry.holders.push(holder);
  }
  return [...byAddress.values()].sort((left, right) => compareAddresses(left.address, right.address));
}
