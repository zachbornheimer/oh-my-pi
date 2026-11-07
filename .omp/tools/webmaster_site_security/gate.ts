import { lookup as dnsLookup } from "node:dns";
import { lookup as resolveAll } from "node:dns/promises";
import { createServer, request as dialHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, connect as dialSocket, isIP, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { type AddressPolicy, isPublicAddress, lookupWith } from "./net.ts";

/**
 * A gate in front of the browser. Everything the browser fetches goes to this local proxy, and no destination is
 * reached that is not a public address: refused before the dial, and dialed through a lookup that refuses a private
 * address wherever the browser asks for one (a page cannot reach the loopback, the LAN or a metadata address, redirects,
 * subresources and websockets included). Port of Mastra's `browser_destination_gate.ts` and `destinations`.
 */

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

export interface DestinationRule {
  /** Why this host must not be reached, or undefined when it may. */
  readonly refuses: (host: string) => Promise<string | undefined>;
  /** The lookup a connection is dialed with, so the address a dial really uses is refused, not only where it was checked. */
  readonly dialing: LookupFunction;
}

/** The rule: public addresses only, except the hosts the caller names (tests allow a local server). */
export function destinations(allowedPrivateHosts: readonly string[] = [], policy: AddressPolicy = isPublicAddress): DestinationRule {
  const allowed = new Set(allowedPrivateHosts.map((host) => host.toLowerCase()));
  const publicLookup = lookupWith(policy);
  return {
    async refuses(host) {
      const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
      if (allowed.has(bare)) return undefined;
      if (isIP(bare) !== 0) return policy(bare) ? undefined : `${bare} is a private network address`;
      let found: { address: string }[];
      try {
        found = await resolveAll(bare, { all: true });
      } catch {
        return `${bare} did not resolve`;
      }
      const blocked = found.find((entry) => !policy(entry.address));
      return blocked === undefined ? undefined : `${bare} resolves to a private network address (${blocked.address})`;
    },
    dialing(host, options, callback) {
      if (allowed.has(host.toLowerCase())) dnsLookup(host, options, callback);
      else publicLookup(host, options, callback);
    },
  };
}

function targetOf(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

const hostOf = (target: URL): string => target.hostname.replace(/^\[|\]$/g, "");

function withoutHopHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    kept[name] = value;
  }
  return kept;
}

/** A plain http request the browser sent to the proxy. Only a GET goes out; the host is refused before the dial. */
async function forward(request: IncomingMessage, response: ServerResponse, rule: DestinationRule): Promise<void> {
  const target = targetOf(request.url);
  if (target === undefined || target.protocol !== "http:") {
    response.writeHead(400, { "content-type": "text/plain" }).end("the proxy reads only an http address");
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "text/plain" }).end("only a GET is sent");
    return;
  }
  const refused = await rule.refuses(hostOf(target));
  if (refused !== undefined) {
    response.writeHead(502, { "content-type": "text/plain" }).end(refused);
    return;
  }
  const headers = withoutHopHeaders(request.headers);
  headers.host = target.host;
  const upstream = dialHttp({
    host: hostOf(target),
    port: target.port === "" ? 80 : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    headers,
    lookup: rule.dialing,
  });
  upstream.on("response", (answer) => {
    response.writeHead(answer.statusCode ?? 502, withoutHopHeaders(answer.headers));
    answer.pipe(response);
  });
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
}

/** A CONNECT tunnel (TLS or websocket): the destination is all the gate can hold to, and it does so as above. */
async function tunnel(request: IncomingMessage, client: Duplex, head: Buffer, rule: DestinationRule, track: (socket: Duplex) => void): Promise<void> {
  const target = targetOf(request.url);
  if (target === undefined || (await rule.refuses(hostOf(target))) !== undefined) {
    client.destroy();
    return;
  }
  const upstream = dialSocket({ host: hostOf(target), port: target.port === "" ? 443 : Number(target.port), lookup: rule.dialing });
  track(upstream);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
}

export interface DestinationGate {
  /** The address to give the browser as its proxy. */
  readonly proxy: string;
  /** The destinations the gate refused, so a measurement can say what the page tried to reach. */
  readonly refused: readonly string[];
  close(): Promise<void>;
}

export async function openDestinationGate(rule: DestinationRule): Promise<DestinationGate> {
  const open = new Set<Duplex>();
  const refused: string[] = [];
  const noting: DestinationRule = {
    dialing: rule.dialing,
    refuses: async (host) => {
      const why = await rule.refuses(host);
      if (why !== undefined && !refused.includes(why)) refused.push(why);
      return why;
    },
  };
  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  };
  const server = createServer();
  server.on("request", (request, response) => void forward(request, response, noting));
  server.on("connect", (request, client, head) => {
    track(client);
    void tunnel(request, client, head, noting, track);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    proxy: `http://127.0.0.1:${port}`,
    refused,
    close: async () => {
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
