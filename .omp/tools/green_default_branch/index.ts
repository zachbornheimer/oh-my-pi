import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { buildTool } from "./tool.js";

const factory: CustomToolFactory = (pi) => buildTool(pi);

export default factory;
