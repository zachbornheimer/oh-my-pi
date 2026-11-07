import { createServer, request as dialHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as dialSocket, type AddressInfo, type LookupFunction } from "node:net";
import type { Duplex } from "node:stream";

/** Headers that describe one connection to one end; the next hop sets its own. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Where a request may reach: the reason a host is refused, and the lookup a connection to it is dialed with. */
export interface DestinationRule {
  /** Why this host must not be reached, or undefined when it may. */
  readonly refuses: (host: string) => Promise<string | undefined>;
  /** The lookup a connection is dialed with, so the address a dial really uses is refused here, not only where it was checked. */
  readonly dialing: LookupFunction;
}

/** What the browser asked the proxy for, as an address: a plain request carries the whole address, a CONNECT only the host and port behind it. */
function targetOf(raw: string | undefined): URL | undefined {
  if (raw === undefined) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

/** The host as an address to reach, without the brackets an IPv6 address is written in. */
const hostOf = (target: URL): string => target.hostname.replace(/^\[|\]$/g, "");

function withoutHopHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * A plain request the browser sent to the proxy: the address to reach is the request's own. The host is refused before
 * the dial, because a dial to an address written out in full — `127.0.0.2` — never asks a lookup.
 */
async function forward(request: IncomingMessage, response: ServerResponse, rule: DestinationRule): Promise<void> {
  const target = targetOf(request.url);
  if (target === undefined || target.protocol !== "http:") {
    response.writeHead(400, { "content-type": "text/plain" }).end("the proxy reads only an http address");
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
    method: request.method,
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

/**
 * A CONNECT tunnel, which carries whatever the browser speaks inside it: TLS for an https or wss address, a websocket
 * handshake for a ws one. The gate cannot read inside, so the destination is all it can hold to, and it holds to it the
 * same way as above: refused before the dial, and dialed through the lookup that refuses a private address.
 */
async function tunnel(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  rule: DestinationRule,
  track: (socket: Duplex) => void,
): Promise<void> {
  const target = targetOf(request.url);
  if (target === undefined) {
    client.destroy();
    return;
  }
  if ((await rule.refuses(hostOf(target))) !== undefined) {
    client.destroy();
    return;
  }
  const upstream = dialSocket({
    host: hostOf(target),
    port: target.port === "" ? 443 : Number(target.port),
    lookup: rule.dialing,
  });
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
  /** The address to give the browser as its proxy, so every request it makes is sent to this gate. */
  readonly proxy: string;
  close(): Promise<void>;
}

/**
 * A gate in front of the browser: everything it fetches is sent to this proxy, and no destination is reached that the
 * rule refuses. The probe's request filter aborts what it can see, but a websocket handshake leaves the browser as a
 * tunnel, which the filter never reads, so on its own it leaves a page free to open a socket to a host it never saw; and
 * the browser looks a name up again when it connects, so a check that only ran in the filter leaves a name free to
 * answer with a public address for the check and a private one for the connection. Which requests may be made stays the
 * filter's rule; which addresses may be dialed is this gate's.
 *
 * The browser must also be told to send loopback traffic here: it bypasses a proxy for a loopback target unless the
 * bypass list is taken back with `<-loopback>`, and a page reaching the loopback is the case this gate exists for.
 */
export async function openDestinationGate(rule: DestinationRule): Promise<DestinationGate> {
  const open = new Set<Duplex>();
  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  };
  const server = createServer();
  server.on("request", (request, response) => void forward(request, response, rule));
  server.on("connect", (request, client, head) => {
    track(client);
    void tunnel(request, client, head, rule, track);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    proxy: `http://127.0.0.1:${port}`,
    close: async () => {
      // A tunnel outlives the request that opened it, so closing the listener is not enough: every socket it holds is
      // taken down first, or the measurement waits on a page that no longer exists.
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
