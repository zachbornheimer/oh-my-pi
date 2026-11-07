import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_security_dns_dangling` custom tool: port of the Mastra capability of the same name, with the DNS
 * collection (`webmaster.site.dns`) built in, so it needs no gateway.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
