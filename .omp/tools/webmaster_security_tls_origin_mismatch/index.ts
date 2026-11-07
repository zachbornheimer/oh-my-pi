import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_security_tls_origin_mismatch` custom tool: port of the Mastra capability of the same name, with
 * the certificate collection (`webmaster.site.certificate`) built in, so it needs no gateway.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
