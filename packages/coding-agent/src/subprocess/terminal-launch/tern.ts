import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { launchError, parseJson, runStep } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Tern",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["direct"],
		target: "block",
		direction: ["right", "down"],
	},
	window: {
		displayName: "tab",
		execution: ["direct"],
		target: "session",
	},
} as const satisfies SupportedMultiplexerCapabilities;

/** `tern split BLOCK` and `tern new tab SESSION` take the target positionally, so an option-looking one is refused. */
function checkTarget(request: TerminalLaunchRequest, target: string): void {
	if (target.startsWith("-")) throw launchError(request, "target", "The Tern launch target cannot start with '-'.");
}

/** Tern reports ids as JSON numbers. */
function numericId(value: unknown): string | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
}

const launchTern: TerminalLaunchBackend<"tern", typeof capabilities> = async (
	request,
	{ environment: env, runCli },
) => {
	if (!hasTerminalMultiplexerSession("tern", env)) {
		throw launchError(request, "capability", "Tern launch requires an active Tern pane.");
	}
	// Tern exports its own executable path into every pane; PATH may not carry it.
	const cli = env.TERN_EXE?.trim() || "tern";
	// `--` makes Tern run the command as exact argv, with no shell in between.
	const launchArgs = ["--json", "--cwd", request.cwd, "--", ...request.command];

	if (request.placement === "pane") {
		const target = request.target ?? env.TERN_PANE;
		if (!target) throw launchError(request, "target", "Tern pane launch requires a block ID or TERN_PANE.");
		checkTarget(request, target);
		const output = await runStep(
			request,
			"split",
			[cli, "split", target, request.direction ?? "right", ...launchArgs],
			request.cwd,
			runCli,
		);
		const id = numericId(parseJson(request, "split", output).block);
		if (!id) throw launchError(request, "split", "Tern split returned no block ID.");
		return { multiplexer: "tern", placement: "pane", id };
	}

	const sessionArgs: string[] = [];
	if (request.target) {
		checkTarget(request, request.target);
		sessionArgs.push(request.target);
	}
	const output = await runStep(
		request,
		"new tab",
		[cli, "new", "tab", ...sessionArgs, ...launchArgs],
		request.cwd,
		runCli,
	);
	const id = numericId(parseJson(request, "new tab", output).tab);
	if (!id) throw launchError(request, "new tab", "Tern new tab returned no tab ID.");
	return { multiplexer: "tern", placement: "window", id };
};

export const ternLaunchProvider: TerminalLaunchProvider<"tern", typeof capabilities> = {
	capabilities,
	launch: launchTern,
};
