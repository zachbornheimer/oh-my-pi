import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_security_email_dmarc` custom tool: port of the Mastra capability of the same name, with the DNS
 * collection (`webmaster.site.dns` for the `_dmarc` name) built in, so it needs no gateway.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
