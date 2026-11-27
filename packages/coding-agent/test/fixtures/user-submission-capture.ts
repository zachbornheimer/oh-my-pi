import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";

/** A real host receipt without a provider request: consume only the uniquely marked test submission. */
export default function capture(pi: ExtensionAPI): void {
	pi.on("user_prompt_submitted", (event, ctx) => {
		const path = process.env.OMP_SUBMISSION_RECEIPT;
		const marker = process.env.OMP_SUBMISSION_MARKER;
		if (!path || !marker || event.text !== marker) return;
		appendFileSync(
			path,
			`${JSON.stringify({ requestId: event.requestId, sessionId: event.sessionId, text: event.text, source: event.source, transport: event.transport, hasUI: ctx.hasUI })}\n`,
		);
		return { handled: true };
	});
}
