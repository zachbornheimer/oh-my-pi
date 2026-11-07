import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_site_security` custom tool: port of the Mastra capability `webmaster.site.security` and the
 * `webmaster-site-security-daily` workflow, with every data collection and all 22 checks built in, so it needs no
 * gateway, Mastra or capability CLI.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
