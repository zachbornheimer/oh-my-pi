import { describe, expect, it } from "bun:test";
import { compileToolCommandGlobs, isMountableAsToolCommand } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";

const discoverable = (name: string) => ({ name, loadMode: "discoverable" as const });

describe("tools.commandAlwaysOn predicate", () => {
	it("pins a matching discoverable tool top-level and leaves the rest mountable", () => {
		const globs = compileToolCommandGlobs(["mcp__server_alpha_*"]);
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha_run"), globs)).toBe(false);
		expect(isMountableAsToolCommand(discoverable("mcp__server_beta_other"), globs)).toBe(true);
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha"), globs)).toBe(true);
	});

	it("is a no-op when the setting is empty or unset", () => {
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha_run"))).toBe(true);
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha_run"), compileToolCommandGlobs([]))).toBe(true);
	});

	it("supports several patterns and exact names", () => {
		const globs = compileToolCommandGlobs(["mcp__server_alpha_*", "lsp"]);
		expect(isMountableAsToolCommand(discoverable("lsp"), globs)).toBe(false);
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha_run"), globs)).toBe(false);
		expect(isMountableAsToolCommand(discoverable("browser"), globs)).toBe(true);
	});

	it("ignores malformed pattern entries instead of throwing", () => {
		const malformed = ["", 7, null, "mcp__server_alpha_*"] as unknown as string[];
		const globs = compileToolCommandGlobs(malformed);
		expect(globs).toHaveLength(1);
		expect(isMountableAsToolCommand(discoverable("mcp__server_alpha_run"), globs)).toBe(false);
		expect(compileToolCommandGlobs("mcp__server_alpha_*" as unknown as string[])).toEqual([]);
	});

	it("keeps the command transport itself unmountable regardless", () => {
		expect(isMountableAsToolCommand(discoverable("bash"), compileToolCommandGlobs(["nothing"]))).toBe(false);
	});
});
