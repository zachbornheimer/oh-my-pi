import type { NetAnswer, SecurityNet } from "./net.ts";

export interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}

/** What a recorded network answers: HTTP by address; an `Error` is a request that got no answer. */
export interface NetWorld {
  readonly http?: Readonly<Record<string, NetAnswer | Error>>;
}

const NOT_FOUND: NetAnswer = { status: 404, contentType: "text/html", body: "<html>Not Found</html>" };

/** A recorded network: answers from `world`, records every request, never reaches the internet. */
export class FakeSecurityNet implements SecurityNet {
  readonly sent: SentRequest[] = [];

  constructor(private readonly world: NetWorld = {}) {}

  async request(method: "GET" | "HEAD" | "POST", url: string, body?: string): Promise<NetAnswer> {
    this.sent.push({ method, url, ...(body === undefined ? {} : { body }) });
    const answer = this.world.http?.[url] ?? NOT_FOUND;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
