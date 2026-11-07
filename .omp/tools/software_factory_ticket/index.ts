import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { livePorts } from "./live_ports.js";
import { ticketTool } from "./ticket_tool.js";

const factory: CustomToolFactory = ticketTool((signal) => livePorts(signal === undefined ? {} : { signal }));

export default factory;
