import { createSocket } from "node:dgram";
import { isIPv6 } from "node:net";

/** What a name holds in the fake zone. A name that is not in the zone does not exist (NXDOMAIN). */
export interface ZoneName {
  a?: string[];
  aaaa?: string[];
  txt?: string[];
  cname?: string;
  mx?: [priority: number, host: string][];
  ns?: string[];
  /** Answer SERVFAIL instead of any record. */
  fail?: boolean;
}
export type Zone = Record<string, ZoneName>;

const TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 } as const;

const nameBytes = (name: string): Buffer =>
  Buffer.concat([
    ...name.split(".").filter((label) => label !== "").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);

const u16 = (value: number): Buffer => Buffer.from([value >> 8, value & 0xff]);

function ipv6Bytes(address: string): Buffer {
  const [head = "", tail] = address.split("::");
  const groups = (text: string) => (text === "" ? [] : text.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = Array<string>(8 - left.length - right.length).fill("0");
  return Buffer.concat([...left, ...zeros, ...right].map((group) => u16(Number.parseInt(group, 16))));
}

function record(owner: string, type: number, data: Buffer): Buffer {
  const ttl = Buffer.from([0, 0, 0, 60]);
  return Buffer.concat([nameBytes(owner), u16(type), u16(1), ttl, u16(data.length), data]);
}

function recordsOf(owner: string, entry: ZoneName, type: number): Buffer[] {
  if (type === TYPES.A) return (entry.a ?? []).map((ip) => record(owner, type, Buffer.from(ip.split(".").map(Number))));
  if (type === TYPES.AAAA) return (entry.aaaa ?? []).map((ip) => record(owner, type, isIPv6(ip) ? ipv6Bytes(ip) : Buffer.alloc(16)));
  if (type === TYPES.TXT) {
    return (entry.txt ?? []).map((text) => {
      const strings = text.match(/[\s\S]{1,255}/g) ?? [""];
      return record(owner, type, Buffer.concat(strings.map((chunk) => Buffer.concat([Buffer.from([chunk.length]), Buffer.from(chunk)]))));
    });
  }
  if (type === TYPES.MX) return (entry.mx ?? []).map(([priority, host]) => record(owner, type, Buffer.concat([u16(priority), nameBytes(host)])));
  if (type === TYPES.NS) return (entry.ns ?? []).map((host) => record(owner, type, nameBytes(host)));
  if (type === TYPES.CNAME) return entry.cname === undefined ? [] : [record(owner, type, nameBytes(entry.cname))];
  return [];
}

/** The answer section for `name` and `type`, following CNAMEs as a recursive server does; `rcode` 3 when the chain ends nowhere. */
function resolve(zone: Zone, name: string, type: number): { answers: Buffer[]; rcode: number } {
  const answers: Buffer[] = [];
  let current = name;
  for (let hop = 0; hop < 8; hop++) {
    const entry = zone[current];
    if (entry === undefined) return { answers, rcode: 3 };
    if (entry.fail === true) return { answers: [], rcode: 2 };
    if (type !== TYPES.CNAME && entry.cname !== undefined) {
      answers.push(...recordsOf(current, entry, TYPES.CNAME));
      current = entry.cname;
      continue;
    }
    answers.push(...recordsOf(current, entry, type));
    return { answers, rcode: 0 };
  }
  return { answers, rcode: 0 };
}

/** A UDP DNS server on 127.0.0.1 that answers A, AAAA, TXT, CNAME, MX and NS from `zone`; `queries` records what was asked. */
export async function serveDns(zone: Zone): Promise<{ port: number; queries: string[]; close(): void }> {
  const queries: string[] = [];
  const socket = createSocket("udp4");
  socket.on("message", (message, remote) => {
    let offset = 12;
    const labels: string[] = [];
    while (message[offset] !== 0) {
      const length = message[offset]!;
      labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
      offset += length + 1;
    }
    offset += 1;
    const type = message.readUInt16BE(offset);
    const name = labels.join(".").toLowerCase();
    queries.push(`${Object.entries(TYPES).find(([, value]) => value === type)?.[0] ?? type} ${name}`);
    const { answers, rcode } = resolve(zone, name, type);
    const header = Buffer.concat([message.subarray(0, 2), u16(0x8180 | rcode), u16(1), u16(answers.length), u16(0), u16(0)]);
    const question = message.subarray(12, offset + 4);
    socket.send(Buffer.concat([header, question, ...answers]), remote.port, remote.address);
  });
  const { promise, resolve: listening } = Promise.withResolvers<void>();
  socket.bind(0, "127.0.0.1", () => listening());
  await promise;
  return { port: socket.address().port, queries, close: () => socket.close() };
}
