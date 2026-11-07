import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_site_audit_weekly` custom tool: port of the Mastra workflow `webmaster-site-audit-weekly`, with the site
 * security and sitemap checks built in, so it needs no gateway or Mastra. The page audit's logic is copied in, so the tool is self-contained.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi);

export default factory;
