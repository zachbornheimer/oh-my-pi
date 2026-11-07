import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool";

/**
 * Native `webmaster_schedule_run` custom tool: the policy layer of the Mastra `webmaster-schedule-run` workflow
 * (per-site lock, stage logic, run records, `only`, reminder). Ports that are Mastra workflow chains answer `BLOCKED`.
 */
const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
