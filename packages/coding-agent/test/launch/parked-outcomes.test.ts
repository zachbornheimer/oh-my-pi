import { afterEach, describe, expect, it, vi } from "bun:test";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import { settledParkedOutcomes } from "@oh-my-pi/pi-coding-agent/launch/parked-outcomes";
import type { DaemonOperation, DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

function daemon(name: string, fields: Partial<DaemonSnapshot>): DaemonSnapshot {
	return { name, state: "exited", ...fields } as DaemonSnapshot;
}

/** A broker listing `daemons` whose logs are `logs[name]`; records every operation it is sent. */
function fakeBroker(daemons: DaemonSnapshot[], logs: Record<string, string>) {
	const operations: DaemonOperation[] = [];
	const client = {
		projectDir: "/tmp/parked",
		request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
			operations.push(operation);
			if (operation.op === "list") return { op: "list", daemons };
			if (operation.op === "logs") {
				return {
					op: "logs",
					name: operation.name,
					text: logs[operation.name] ?? "",
					cursor: 0,
					timedOut: false,
					state: "exited",
				};
			}
			throw new Error(`unexpected ${operation.op}`);
		},
		close: () => {},
	} as unknown as daemonClient.DaemonBrokerClient;
	vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
	return operations;
}

const call = (jobId: string) => ({ toolCallId: `call_${jobId}`, toolName: "bash", jobId });

describe("settledParkedOutcomes", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the output of a finished job and keeps a still-running or unknown one parked", async () => {
		const operations = fakeBroker(
			[daemon("done", { state: "exited", exitCode: 0 }), daemon("busy", { state: "running" })],
			{ done: "build ok\n", busy: "still going\n" },
		);
		const settled = await settledParkedOutcomes("/tmp/parked", [call("done"), call("busy"), call("gone")]);
		expect([...settled.keys()]).toEqual(["done"]);
		expect(settled.get("done")).toEqual({ text: "build ok\n\n[exit code 0]", isError: false });
		// Only the finished job's logs are read.
		expect(operations.filter(operation => operation.op === "logs")).toHaveLength(1);
	});

	it("marks a non-zero exit and a broker-reported failure as errors", async () => {
		fakeBroker(
			[
				daemon("bad", { state: "exited", exitCode: 3 }),
				daemon("crashed", { state: "failed", exitReason: "spawn failed" }),
			],
			{ bad: "boom", crashed: "" },
		);
		const settled = await settledParkedOutcomes("/tmp/parked", [call("bad"), call("crashed")]);
		expect(settled.get("bad")).toEqual({ text: "boom\n[exit code 3]", isError: true });
		expect(settled.get("crashed")).toEqual({ text: "\n[spawn failed]", isError: true });
	});

	it("keeps only the tail of an oversized log and never drops the exit line", async () => {
		fakeBroker([daemon("big", { state: "exited", exitCode: 0 })], { big: `${"a".repeat(70_000)}END` });
		const settled = await settledParkedOutcomes("/tmp/parked", [call("big")]);
		const text = settled.get("big")?.text ?? "";
		expect(text.endsWith("END\n[exit code 0]")).toBe(true);
		// 64 KiB of log tail plus the short exit line, not the whole 70 KB.
		expect(text.length).toBe(64 * 1024 + "\n[exit code 0]".length);
	});

	it("does not contact the broker when nothing is parked", async () => {
		const spy = vi.spyOn(daemonClient, "daemonClientForProject");
		expect((await settledParkedOutcomes("/tmp/parked", [])).size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});
