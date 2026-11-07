import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

const PRIVATE_RANGES = new BlockList();
for (
  const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`), if it is one. */
function mappedIPv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Loopback, RFC1918, link-local, CGNAT, multicast, reserved and unspecified addresses. Anything that is not an address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = mappedIPv4(address);
  if (mapped) return PRIVATE_RANGES.check(mapped, "ipv4");
  return PRIVATE_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

class PrivateNetworkError extends Error {}

function privateTargetError(host: string, address: string): PrivateNetworkError {
  return new PrivateNetworkError(
    `${host} is on a private network (${address}); loopback, RFC1918, link-local and other private addresses are refused`,
  );
}

/**
 * Checks the address a connection really uses, so a name that resolves to a private address, or changes between checks,
 * is still refused.
 */
export const publicAddressLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const resolved = typeof address === "string" ? [address] : address.map((entry) => entry.address);
    const blocked = resolved.find(isPrivateAddress);
    if (blocked !== undefined) {
      callback(privateTargetError(hostname, blocked), "", 0);
      return;
    }
    callback(null, address as string & { address: string; family: number }[], family);
  });
};
