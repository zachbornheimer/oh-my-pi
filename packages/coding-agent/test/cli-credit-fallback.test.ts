import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const binary = process.env.OMP_TEST_BINARY;
const creditError =
	"You have run out of credits or need a Grok subscription (type=personal-team-blocked:spending-limit)";
const token = "CREDIT-FALLBACK-CONTEXT-42";

function model(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 1024,
	};
}

describe("real CLI exhausted route recovery", () => {
	test.each([
		{
			name: "credit exhaustion",
			status: 403,
			message: creditError,
			exhausted: false,
			sequence: ["primary", "fallback"],
			exit: 0,
		},
		{
			name: "billing budget exhaustion",
			status: 422,
			message: "Budget has been exceeded!",
			exhausted: false,
			sequence: ["primary", "fallback"],
			exit: 0,
		},
		{
			name: "user cancellation does not switch models",
			status: 400,
			message: "unused",
			exhausted: true,
			sequence: ["primary"],
			exit: 0,
			cancel: true,
		},
		{
			name: "all routes exhausted",
			status: 403,
			message: creditError,
			exhausted: true,
			sequence: ["primary", "fallback"],
			exit: 1,
		},
	])(
		"$name",
		async scenario => {
			const tempDir = mkdtempSync(path.join(tmpdir(), "omp-credit-fallback-"));
			const requests: Array<{ model: string; messages: unknown }> = [];
			let cancelRequest: (() => void) | undefined;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const body = (await request.json()) as { model: string; messages: unknown };
					requests.push({ model: body.model, messages: body.messages });
					if (cancelRequest) {
						const cancelled = Promise.withResolvers<Response>();
						request.signal.addEventListener(
							"abort",
							() => cancelled.resolve(new Response(null, { status: 499 })),
							{ once: true },
						);
						cancelRequest();
						return cancelled.promise;
					}
					if (body.model === "primary" || scenario.exhausted) {
						return Response.json({ error: { message: scenario.message } }, { status: scenario.status });
					}
					return new Response(
						[
							`data: ${JSON.stringify({ id: "recovered", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: token }, finish_reason: null }] })}\n\n`,
							`data: ${JSON.stringify({ id: "recovered", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
							"data: [DONE]\n\n",
						].join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			try {
				const home = path.join(tempDir, "home");
				const agentDir = path.join(home, ".omp", "agent");
				await Bun.write(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							loopback: {
								baseUrl: `${server.url.origin}/v1`,
								api: "openai-completions",
								auth: "none",
								models: [model("primary"), model("fallback")],
							},
						},
					}),
				);
				await Bun.write(
					path.join(agentDir, "config.yml"),
					JSON.stringify({
						modelRoles: { default: "loopback/fallback", task: "loopback/primary" },
						defaultThinkingLevel: "off",
						retry: {
							enabled: true,
							modelFallback: true,
							fallbackOn: "any",
							rateLimitWalksChain: true,
							usageAwareFallback: false,
							waitForUsageReset: false,
							maxRetries: 1,
							baseDelayMs: 1,
							maxDelayMs: 100,
							fallbackRevertPolicy: "never",
							fallbackChains: { task: ["loopback/primary", "loopback/fallback"] },
						},
						compaction: { enabled: false },
					}),
				);
				const overlay = path.join(tempDir, "pin-model.yml");
				await Bun.write(overlay, "retry:\n  modelFallback: true\n");
				const proc = Bun.spawn(
					[
						...(binary ? [binary] : [process.execPath, cliEntry]),
						"--no-title",
						"--no-lsp",
						"--no-extensions",
						"--no-tools",
						"--no-context-files",
						"--no-skills",
						"--no-rules",
						"--model",
						"@task",
						"--config",
						overlay,
						...(scenario.cancel ? ["--mode", "rpc"] : ["-p", token]),
					],
					{
						cwd: tempDir,
						env: {
							PATH: process.env.PATH,
							HOME: home,
							USERPROFILE: home,
							PI_CODING_AGENT_DIR: agentDir,
							NO_COLOR: "1",
							...(process.env.PI_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.PI_NATIVES_DIR } : {}),
						},
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				if (scenario.cancel) {
					cancelRequest = () => proc.stdin.write(`${JSON.stringify({ id: "cancel", type: "abort" })}\n`);
					proc.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: token })}\n`);
				} else {
					proc.stdin.end();
				}
				const stdoutResult = (async () => {
					let output = "";
					for await (const bytes of proc.stdout) {
						output += new TextDecoder().decode(bytes);
						if (scenario.cancel && output.includes('"type":"agent_end"')) proc.stdin.end();
					}
					return output;
				})();
				// Failure deadline for a real child process, not a synchronization sleep.
				const timer = setTimeout(() => proc.kill(), 20_000);
				try {
					const [exitCode, stdout, stderr] = await Promise.all([
						proc.exited,
						stdoutResult,
						new Response(proc.stderr).text(),
					]);
					expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: scenario.exit });
					expect(requests.map(request => request.model)).toEqual(scenario.sequence);
					expect(requests.every(request => JSON.stringify(request.messages).includes(token))).toBe(true);
					if (requests.length > 1) expect(requests[1]?.messages).toEqual(requests[0]?.messages);
					if (!scenario.exhausted) expect(stdout).toContain(token);
					console.log(
						`${scenario.name}: ${requests.map(request => `loopback/${request.model}`).join(" -> ")}; context preserved; exit ${exitCode}`,
					);
				} finally {
					clearTimeout(timer);
					proc.kill();
					await proc.exited;
				}
			} finally {
				server.stop(true);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

test.skipIf(!process.env.OMP_FALLBACK_CONFIG)("configured roles retain distinct fallback routes", async () => {
	const config = Bun.YAML.parse(await Bun.file(process.env.OMP_FALLBACK_CONFIG!).text()) as {
		modelRoles: Record<string, string>;
		retry: { fallbackChains: Record<string, string[]> };
	};
	const resolve = (selector: string): string => {
		const base = selector.replace(/:[^/:]+$/, "");
		return base.startsWith("@") ? resolve(config.modelRoles[base.slice(1)]!) : base;
	};
	for (const role of Object.keys(config.modelRoles)) {
		const chain = config.retry.fallbackChains[role] ?? config.retry.fallbackChains.default!;
		expect(new Set([resolve(config.modelRoles[role]!), ...chain.map(resolve)]).size, role).toBeGreaterThan(1);
		if (["task", "design", "judge"].includes(role))
			console.log(
				`${role}: ${[...new Set([resolve(config.modelRoles[role]!), ...chain.map(resolve)])].join(" -> ")}`,
			);
	}
});
