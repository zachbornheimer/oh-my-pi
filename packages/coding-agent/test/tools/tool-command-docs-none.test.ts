import { describe, expect, it } from "bun:test";
import { cfgToolsCommandDocs } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	planToolCommandPromptDocs,
	renderToolCommandPromptDocs,
	type ToolCommandState,
} from "@oh-my-pi/pi-coding-agent/tools/tool-commands";

function stateWith(names: string[]): ToolCommandState {
	const tools = new Map<string, unknown>();
	for (const name of names) {
		tools.set(name, { name, label: name, description: `${name} tool`, parameters: { type: "object" } });
	}
	return {
		tools: tools as ToolCommandState["tools"],
		mountedNames: new Set(names),
		builtInNames: new Set(names),
		isActive: () => false,
	};
}

describe("tools.commandDocs none", () => {
	it("is a registered setting value", () => {
		const opts = (cfgToolsCommandDocs as unknown as { ui: { options: { value: string }[] } }).ui.options;
		expect(opts.map(o => o.value)).toContain("none");
	});

	it("plans no inline docs and no catalog for mounted commands", () => {
		const plan = planToolCommandPromptDocs(stateWith(["lsp", "browser"]), "none");
		expect(plan.sections).toEqual([]);
		expect(plan.catalog.size).toBe(0);
		expect(renderToolCommandPromptDocs(plan)).toBe("");
	});

	it("still plans catalog docs in catalog mode", () => {
		const plan = planToolCommandPromptDocs(stateWith(["lsp"]), "catalog");
		expect(plan.catalog.has("lsp")).toBe(true);
	});
});
