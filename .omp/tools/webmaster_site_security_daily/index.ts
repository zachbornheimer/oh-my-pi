import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_site_security_daily` custom tool: port of the Mastra workflow `webmaster-site-security-daily`
 * (the daily run of `webmaster.site.security` over every site file that lists `security`), with the 22 checks and every
 * data collection built in. The 06:30 schedule is not part of the tool.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
