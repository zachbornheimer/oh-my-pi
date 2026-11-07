import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { livePorts } from "./live_ports.js";
import { sweepTool } from "./sweep_tool.js";

const factory: CustomToolFactory = sweepTool((signal) => livePorts(signal === undefined ? {} : { signal }));

export default factory;
