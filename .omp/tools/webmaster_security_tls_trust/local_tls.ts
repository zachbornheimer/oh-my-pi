import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";

/** A throwaway self-signed certificate for `localhost` (valid 2 days), made with the system's `openssl`. */
export function selfSignedLocalhost(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "local-tls-"));
  try {
    const run = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ], { shell: false });
    if (run.status !== 0) throw new Error(`openssl failed: ${String(run.stderr)}`);
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A TLS server on 127.0.0.1 that presents `credentials` to every client; `close()` stops it. */
export async function serveTls(credentials: { key: string; cert: string }): Promise<{ port: number; close(): void }> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const server: TlsServer = createTlsServer(credentials, (socket) => socket.end());
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the local TLS server has no port");
  return { port: address.port, close: () => server.close() };
}

/** A TCP server on 127.0.0.1 that accepts connections and never answers, so a handshake with it stalls. */
export async function serveSilence(): Promise<{ port: number; close(): void }> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the silent server has no port");
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** A port nothing listens on: bind one, note it, release it. */
export async function closedPort(): Promise<number> {
  const server = await serveSilence();
  server.close();
  return server.port;
}
