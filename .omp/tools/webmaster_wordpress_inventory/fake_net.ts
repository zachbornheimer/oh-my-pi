import type { NetAnswer, SecurityNet } from "./net.ts";

/** A recorded network: answers from `http` by address (an `Error` is a request that got no answer), records every request. */
export class FakeSecurityNet implements SecurityNet {
  readonly sent: { method: string; url: string }[] = [];
  constructor(private readonly http: Readonly<Record<string, NetAnswer | Error>> = {}) {}

  async request(method: "GET" | "HEAD" | "POST", url: string): Promise<NetAnswer> {
    this.sent.push({ method, url });
    const answer = this.http[url] ?? { status: 404, contentType: "text/html", body: "" };
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
