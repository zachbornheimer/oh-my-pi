import { afterEach, describe, expect, it, vi } from "bun:test";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonOp, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { settledParkedOutcomes } from "@oh-my-pi/pi-coding-agent/launch/parked-outcomes";

function unit(key: string, fields: Partial<UnitSnapshot>): UnitSnapshot {
	return { id: `id_${key}`, key, kind: "proc", state: "exited", ...fields } as UnitSnapshot;
}

/** A daemon listing `units` whose logs are `logs[key]`; records every operation it is sent. */
function fakeDaemon(units: UnitSnapshot[], logs: Record<string, string>) {
	const operations: DaemonOp[] = [];
	const client = {
		request: async (operation: DaemonOp) => {
			operations.push(operation);
			if (operation.op === "list") return { units };
			if (operation.op === "logs") {
				const target = units.find(candidate => candidate.id === operation.unit);
				return { text: logs[target?.key ?? ""] ?? "", terminalOutput: "", cursor: 0, unit: target };
			}
			throw new Error(`unexpected ${operation.op}`);
		},
		close: () => {},
	} as unknown as DaemonClient;
	vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
	return operations;
}

const call = (jobId: string) => ({ toolCallId: `call_${jobId}`, toolName: "bash", jobId });

describe("settledParkedOutcomes", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the output of a finished job and keeps a still-running or unknown one parked", async () => {
		const operations = fakeDaemon(
			[unit("done", { state: "exited", exitCode: 0 }), unit("busy", { state: "running" })],
			{ done: "build ok\n", busy: "still going\n" },
		);
		const settled = await settledParkedOutcomes("/tmp/parked", [call("done"), call("busy"), call("gone")]);
		expect([...settled.keys()]).toEqual(["done"]);
		expect(settled.get("done")).toEqual({ text: "build ok\n\n[exit code 0]", isError: false });
		// Only the finished job's logs are read.
		expect(operations.filter(operation => operation.op === "logs")).toHaveLength(1);
	});

	it("marks a non-zero exit and a daemon-reported failure as errors", async () => {
		fakeDaemon(
			[
				unit("bad", { state: "exited", exitCode: 3 }),
				unit("crashed", { state: "failed", exitReason: "spawn failed" }),
			],
			{ bad: "boom", crashed: "" },
		);
		const settled = await settledParkedOutcomes("/tmp/parked", [call("bad"), call("crashed")]);
		expect(settled.get("bad")).toEqual({ text: "boom\n[exit code 3]", isError: true });
		expect(settled.get("crashed")).toEqual({ text: "\n[spawn failed]", isError: true });
	});

	it("keeps only the tail of an oversized log and never drops the exit line", async () => {
		fakeDaemon([unit("big", { state: "exited", exitCode: 0 })], { big: `${"a".repeat(70_000)}END` });
		const settled = await settledParkedOutcomes("/tmp/parked", [call("big")]);
		const text = settled.get("big")?.text ?? "";
		expect(text.endsWith("END\n[exit code 0]")).toBe(true);
		expect(text.length).toBe(64 * 1024 + "\n[exit code 0]".length);
	});

	it("does not contact the daemon when nothing is parked", async () => {
		const spy = vi.spyOn(daemonClient, "daemonClient");
		expect((await settledParkedOutcomes("/tmp/parked", [])).size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});
