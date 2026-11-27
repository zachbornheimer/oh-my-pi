/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { entrySearchText } from "../../../../src/modes/view-model/overlays/tree-entry-labels";
import { TreeSelector, type TreeFilterMode, type TreeSelectorNode } from "../../../../src/ui/overlays/pickers/tree-selector";

const host: TreeSelectorNode = {
	entry: { id: "load", parentId: null, type: "host_event", kind: "omp", trigger: "hot-reload" },
	children: [],
};

function pickerIn(node: UiNode): UiNode | undefined {
	if (node.kind === "picker") return node;
	for (const child of node.children()) {
		const picker = pickerIn(child);
		if (picker) return picker;
	}
	return undefined;
}

for (const mode of ["default", "all"] as const satisfies readonly TreeFilterMode[]) {
	test(`host lifecycle entries ${mode === "all" ? "render in all" : "stay hidden in default"} tree view`, () => {
		const term = createTestTerminal(
			() => ({
				layer: (
					<TreeSelector
						roots={[host]}
						currentLeafId="load"
						terminalHeight={30}
						initialFilterMode={mode}
						onSelect={() => {}}
						onCancel={() => {}}
					/>
				),
			}),
			{ columns: 80, rows: 30 },
		);
		try {
			term.render();
			const picker = pickerIn(term.surface.layer()[0]!);
			// The picker node owns these props; UiNode erases its widget-specific type.
			const props = picker?.props() as { items: readonly TspPickerItem[]; order: readonly string[] } | undefined;
			const items = props?.items ?? [];
			expect(props?.order).toEqual(mode === "all" ? ["load"] : []);
			if (mode === "all") {
				const label = items[0]!.label;
				expect(typeof label === "string" ? label : label.map(span => span.t).join("")).toBe(
					"[host event: omp hot-reload]",
				);
			}
		} finally {
			term.dispose();
		}
	});
}

test("tree search indexes host kind and trigger after the UI migration", () => {
	expect(entrySearchText(host.entry, "restart")).toContain("restart host event omp hot-reload");
});
