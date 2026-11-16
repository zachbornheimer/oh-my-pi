import { afterEach, beforeEach, expect, it, describe } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { brokerJobOwner, spawnBrokerJob, waitBrokerJob, claimBrokerOutcome, parkBrokerJob, parkableBrokerJob } from "../../src/tools/job-owner";
import { SessionManager } from "../../src/session/session-manager";
import { AgentSession } from "../../src/session/agent-session";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "../../src/session/auth-storage";
import { ModelRegistry } from "../../src/config/model-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const script = process.env.OMP_JOBOWNER!;
describe.skipIf(!script)("real foreground broker owner", () => {
let root: string;
const saved = { ...process.env };
beforeEach(async () => {
 root = await fs.mkdtemp(path.join(os.tmpdir(), "foreground-park-"));
 process.env.OMP_JOBOWNER = script;
 process.env.OMP_JOBS_ROOT = root;
 process.env.OMP_TERMINAL_PARK_MARKER = path.join(root, "marker");
});
afterEach(async () => {
 for (const key of ["OMP_JOBOWNER", "OMP_JOBS_ROOT", "OMP_TERMINAL_PARK_MARKER"]) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
 }
 await fs.rm(root, { recursive: true, force: true });
});
function session(): ToolSession {
 return { cwd: root, hasUI: false, skills: [], getAgentId: () => "Main", getSessionId: () => "session", getSessionFile: () => null,
 settings: Settings.isolated({ "bashInterceptor.enabled": false, "bash.autoBackground.enabled": false, "bash.park.enabled": true }) } as unknown as ToolSession;
}
it("foreground uses the real owner and keeps ordinary output and exit details", async () => {
 const tool = new BashTool(session());
 const result = await tool.execute("call", { command: "printf hello; exit 7" });
 expect(result.content[0]).toMatchObject({ text: expect.stringContaining("hello") });
 expect(result.details?.exitCode).toBe(7);
 expect(result.isError).toBe(true);
 expect(await fs.readFile(path.join(root, "session/call/exit"), "utf8")).toBe("7\n");
});
it("settled results are claimed exactly once", async () => {
 const owner = brokerJobOwner(process.env)!;
 const job = await spawnBrokerJob(owner, { sessionId: "session", toolCallId: "once", command: "printf done", cwd: root, env: {} });
 await waitBrokerJob(owner, "session", "once", job.dir);
 expect(await claimBrokerOutcome(job.dir)).toMatchObject({ text: expect.stringContaining("done"), isError: false });
 expect(await claimBrokerOutcome(job.dir)).toBeUndefined();
});
it("attached interrupt reaches the real process group", async () => {
 const owner = brokerJobOwner(process.env)!;
 const job = await spawnBrokerJob(owner, { sessionId: "session", toolCallId: "interrupt", command: "sleep 300", cwd: root, env: {} });
 const abort = new AbortController();
 const waiting = waitBrokerJob(owner, "session", "interrupt", job.dir, { signal: abort.signal });
 abort.abort();
 const result = await waiting;
 expect([130, 143]).toContain(result.exitCode!);
 expect(result.cancelled).toBe(true);
 expect(await claimBrokerOutcome(job.dir)).toMatchObject({ interrupted: true, isError: true });
}, 15000);
it("parking detaches without cancelling and a fresh watcher reattaches", async () => {
 const owner = brokerJobOwner(process.env)!;
 const job = await spawnBrokerJob(owner, { sessionId: "session", toolCallId: "park", command: 'while [ ! -f release ]; do sleep 0.1; done; printf survived', cwd: root, env: {} });
 const abort = new AbortController();
 void waitBrokerJob(owner, "session", "park", job.dir, { signal: abort.signal });
 expect(parkableBrokerJob("session")?.toolCallId).toBe("park");
 expect(parkBrokerJob("session", "park")).toBe(true);
 abort.abort();
 await fs.writeFile(path.join(root, "release"), "");
 const result = await waitBrokerJob(owner, "session", "park", job.dir);
 expect(result.exitCode).toBe(0);
 expect(result.output).toBe("survived");
});
it("unset marker preserves the native foreground path", async () => {
 delete process.env.OMP_TERMINAL_PARK_MARKER;
 const result = await new BashTool(session()).execute("native", { command: "printf native" });
 expect(result.content[0]).toMatchObject({ text: expect.stringContaining("native") });
 expect(await fs.stat(path.join(root, "session/native")).catch(() => undefined)).toBeUndefined();
});
it("resumed interrupted job fills its persisted call once and aborts the turn", async () => {
 const owner = brokerJobOwner(process.env)!;
 const job = await spawnBrokerJob(owner, { sessionId: "session", toolCallId: "restore", command: "exit 143", cwd: root, env: {} });
 await waitBrokerJob(owner, "session", "restore", job.dir);
 const auth = await AuthStorage.create(path.join(root, "auth.db"));
 const manager = SessionManager.create(root, root);
 const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
 manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "restore", name: "bash", arguments: { command: "sleep 300" } }],
  api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 manager.appendCustomEntry("parked_tool_call", { toolCallId: "restore", toolName: "bash", jobId: job.dir });
 const agent = new Agent({ initialState: { model, messages: manager.buildSessionContext().messages, tools: [] } });
 const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated({ "compaction.enabled": false }), modelRegistry: new ModelRegistry(auth) });
 try {
  expect(await session.restoreForegroundPark()).toBe(true);
  expect(await session.restoreForegroundPark()).toBe(false);
  const messages = manager.buildSessionContext().messages;
  expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
  expect(manager.getBranch().at(-1)).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "aborted", errorMessage: "Tool interrupted" } });
 } finally { await session.dispose(); auth.close(); }
}, 30000);
});
