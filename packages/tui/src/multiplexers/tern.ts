import type { TerminalMultiplexerModule } from "./types";

/**
 * Tern exports `TERN_PANE` (the block id) and `TERN_PANE_SOCKET` (its daemon socket)
 * into every pane. It is recognized for launches (`tern split` / `tern new tab`)
 * only: omp talks to Tern through its native TSP view rather than the multiplexer
 * screen-grid path, so it keeps `ownsScreenGrid: false`. It ranks as an outer app,
 * below the TERM fallback, so a tmux/screen/herdr/... session started inside a Tern
 * pane still classifies as that multiplexer and every render decision is unchanged.
 */
export const ternMultiplexer = {
	id: "tern",
	precedence: "outerApp",
	sessionEnvKeys: ["TERN_PANE", "TERN_PANE_SOCKET"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		// CLI-only overrides (TERN_EXE) are not proof of a pane; the block id is numeric.
		return Boolean(env.TERN_PANE_SOCKET?.trim() && /^\d+$/u.test(env.TERN_PANE?.trim() ?? ""));
	},
} as const satisfies TerminalMultiplexerModule;
