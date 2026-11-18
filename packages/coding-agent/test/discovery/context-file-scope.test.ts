/**
 * Session context files declare the work they govern: a project file binds its
 * directory tree, a user file binds all work. A session launched inside a
 * checkout must not be instructed to follow that checkout's AGENTS.md for work
 * outside the checkout, while work inside keeps the same rules with full force.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { formatAdvisorContextPrompt } from "@oh-my-pi/pi-coding-agent/advisor/watchdog";

function writeContextFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

/** The single `<repo-rules>` block of a rendered prompt; fails the test when absent. */
function repoRulesBlock(promptText: string): string {
	const match = promptText.match(/<repo-rules>[\s\S]*?<\/repo-rules>/);
	expect(match).not.toBeNull();
	return match?.[0] ?? "";
}

describe("context file binding scope", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let agentDir = "";
	let originalHome: string | undefined;
	// setAgentDir() and the homedir spy rewrite these; restore them all so later test files see the original resolver.
	const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"] as const;
	let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-scope-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		// Bun's os.homedir() ignores $HOME, so user-base discovery (~/.agents, ~/.claude, …) needs the spy.
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		// Isolate user-level discovery; a test needing a user file writes into it.
		agentDir = path.join(tempDir, "agent-dir");
		setAgentDir(agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		__resetDirsFromEnvForTests();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		removeSyncWithRetries(tempDir);
		removeSyncWithRetries(tempHomeDir);
	});

	async function renderedPrompt(cwd: string): Promise<string> {
		const contextFiles = await loadProjectContextFiles({ cwd });
		const { systemPrompt } = await buildSystemPrompt({
			cwd,
			contextFiles,
			skills: [],
			rules: [],
			toolNames: [],
		});
		return systemPrompt.join("\n\n");
	}

	it("binds a project context file to its directory tree, not to every task", async () => {
		const checkoutDir = path.join(tempDir, "checkout");
		writeContextFile(path.join(checkoutDir, "AGENTS.md"), "Checkout rule: never ship on a Friday.");

		const contextFiles = await loadProjectContextFiles({ cwd: checkoutDir });
		expect(contextFiles).toHaveLength(1);
		expect(contextFiles[0]?.level).toBe("project");

		const promptText = await renderedPrompt(checkoutDir);
		const repoRules = repoRulesBlock(promptText);
		expect(repoRules).toContain(`governs="${checkoutDir}"`);
		expect(repoRules).toContain("Checkout rule: never ship on a Friday.");
		expect(repoRules).not.toContain("for all tasks");
	});

	it("keeps instructing a session inside the checkout to follow its rules with the same force", async () => {
		const checkoutDir = path.join(tempDir, "checkout");
		writeContextFile(path.join(checkoutDir, "AGENTS.md"), "Checkout rule: never ship on a Friday.");

		const promptText = await renderedPrompt(checkoutDir);
		const repoRules = repoRulesBlock(promptText);

		expect(repoRules).toContain("MUST follow these context files");
		expect(repoRules).toContain(`path="${path.join(checkoutDir, "AGENTS.md")}"`);
		expect(repoRules).toContain("Checkout rule: never ship on a Friday.");
	});

	it("keeps user-level files binding all work while project files bind their tree", async () => {
		writeContextFile(path.join(agentDir, "AGENTS.md"), "User rule: sign every commit.");
		const checkoutDir = path.join(tempDir, "checkout");
		writeContextFile(path.join(checkoutDir, "AGENTS.md"), "Checkout rule: never ship on a Friday.");

		const contextFiles = await loadProjectContextFiles({ cwd: checkoutDir });
		expect(contextFiles.find(file => file.level === "user")?.path).toBe(path.join(agentDir, "AGENTS.md"));
		expect(contextFiles.find(file => file.level === "project")?.path).toBe(path.join(checkoutDir, "AGENTS.md"));

		const promptText = await renderedPrompt(checkoutDir);
		const repoRules = repoRulesBlock(promptText);
		expect(repoRules).toContain('governs="all work"');
		expect(repoRules).toContain(`governs="${checkoutDir}"`);
		expect(repoRules).toContain("User rule: sign every commit.");
		expect(repoRules).toContain("Checkout rule: never ship on a Friday.");
	});

	it("scopes each ancestor file to its own tree and keeps @imports expanded inside the importing file", async () => {
		const workspaceDir = path.join(tempDir, "workspace");
		const projectDir = path.join(workspaceDir, "project");
		writeContextFile(path.join(workspaceDir, "AGENTS.md"), "Workspace rule: run bun check before landing.");
		writeContextFile(path.join(projectDir, "notes.md"), "Imported note: deploy on Thursdays.");
		writeContextFile(path.join(projectDir, "AGENTS.md"), "Project rule: read @notes.md first.");

		const contextFiles = await loadProjectContextFiles({ cwd: projectDir });
		expect(contextFiles.map(file => file.path)).toEqual([
			path.join(workspaceDir, "AGENTS.md"),
			path.join(projectDir, "AGENTS.md"),
		]);

		const promptText = await renderedPrompt(projectDir);
		const repoRules = repoRulesBlock(promptText);
		expect(repoRules).toContain(`governs="${workspaceDir}"`);
		expect(repoRules).toContain(`governs="${projectDir}"`);
		// `@` imports still expand relative to the importing file's directory.
		expect(repoRules).toContain("Imported note: deploy on Thursdays.");
	});

	it("scopes the advisor's context-file block the same way", async () => {
		writeContextFile(path.join(agentDir, "AGENTS.md"), "User rule: sign every commit.");
		const checkoutDir = path.join(tempDir, "checkout");
		writeContextFile(path.join(checkoutDir, "AGENTS.md"), "Checkout rule: never ship on a Friday.");

		const contextFiles = await loadProjectContextFiles({ cwd: checkoutDir });
		const advisorPrompt = formatAdvisorContextPrompt(contextFiles);
		expect(advisorPrompt).toBeDefined();
		expect(advisorPrompt).toContain(`governs="${checkoutDir}"`);
		expect(advisorPrompt).toContain('governs="all work"');
		expect(advisorPrompt).toContain("User rule: sign every commit.");
		expect(advisorPrompt).toContain("Checkout rule: never ship on a Friday.");
	});
});
