/**
 * Settings declared by the archive memory backend. `memory.backend === "archive"` selects it; these
 * tune it and take effect only while it is selected, so they carry no panel condition of their own.
 */

import { register } from "../../config/registry";

/** How many hits a first-turn recall may inject. */
export const cfgArchiveFirstTurnLimit = register({
	id: "archive.firstTurnLimit",
	type: "number",
	default: 6,
	ui: {
		tab: "memory",
		group: "Archive",
		label: "First-turn recall",
		description: "How many earlier memories a new session's first prompt receives (0 turns recall off)",
		options: [
			{ value: "0", label: "Off" },
			{ value: "3", label: "3" },
			{ value: "6", label: "6" },
			{ value: "10", label: "10" },
		],
	},
});

/** Whether settled sessions write their turns back into the archive. */
export const cfgArchiveAutoRetain = register({
	id: "archive.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Archive",
		label: "Retain on session end",
		description: "Chunk and store this session's turns when it settles, so a later session recalls them",
	},
});

/** User turns that must pass since the last write before a settled turn writes again. */
export const cfgArchiveRetainEveryNTurns = register({ id: "archive.retainEveryNTurns", type: "number", default: 2 });
