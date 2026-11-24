import type { TerminalMultiplexerModule } from "./types";

/** Tern owns a pane but uses the direct-terminal renderer, below nested multiplexers. */
export const ternMultiplexer = {
	id: "tern",
	precedence: "outerApp",
	sessionEnvKeys: ["TERN_PANE_SOCKET", "TERN_PANE"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.TERN_PANE_SOCKET?.trim() && /^\d+$/u.test(env.TERN_PANE?.trim() ?? ""));
	},
} as const satisfies TerminalMultiplexerModule;
