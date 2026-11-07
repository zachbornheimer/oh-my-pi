import { securityFinding, type Verdict } from "./check";
import { succeeded } from "./net";
import { type WordpressPublicApi } from "./public_api";

export const CHECK = "webmaster.security.wordpress.xmlrpc";
const METHOD_NOT_ALLOWED = 405;

/** `/xmlrpc.php`, when it is live. */
export function xmlrpcVerdict(api: WordpressPublicApi | undefined): Verdict {
  if (api?.status !== "measured") return { unmeasured: api?.reason ?? "the public API was not read" };
  const { xmlrpc } = api;
  if (xmlrpc.status === 0) return { unmeasured: `${xmlrpc.path} did not answer: ${xmlrpc.error ?? "no answer"}` };
  const live = xmlrpc.status === METHOD_NOT_ALLOWED && /accepts POST requests only/i.test(xmlrpc.body)
    ? `${xmlrpc.path} answered ${xmlrpc.status}: "XML-RPC server accepts POST requests only."`
    : succeeded(xmlrpc) && /<methodResponse>/.test(xmlrpc.body)
    ? `${xmlrpc.path} answers XML-RPC`
    : undefined;
  if (live === undefined) return [];
  return [securityFinding(
    "security.wordpress.xmlrpc",
    "medium",
    `XML-RPC is live: ${live}. It allows password guessing in bulk and pingback abuse.`,
    "Deny /xmlrpc.php at the web server or the edge unless an app on the site needs it.",
    "Turn XML-RPC off (the `xmlrpc_enabled` filter) or limit it to the services that use it.",
  )];
}
