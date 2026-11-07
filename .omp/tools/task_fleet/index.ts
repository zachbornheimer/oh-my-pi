import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { livePorts } from "./live_ports.js";
import { createTool } from "./tool.js";

const factory: CustomToolFactory = (pi) => createTool(pi, (cwd) => livePorts({ cwd }));

export default factory;
