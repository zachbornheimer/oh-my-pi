import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { makeTool } from "./tool.ts";

const factory: CustomToolFactory = (pi) => makeTool(pi) as never;

export default factory;
