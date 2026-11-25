import { beforeEach, describe, expect, test } from "bun:test";
import {
	currentHostLoads,
	formatHostTime,
	lifecycleSections,
	recordHostLoad,
	resetHostLoadsForTest,
} from "../src/session/host-events";
import { SessionManager } from "../src/session/session-manager";

describe("formatHostTime", () => {
	test("prints month, day, year and a 12-hour clock in local time", () => {
		expect(formatHostTime(new Date(2026, 10, 25, 10, 12))).toBe("Nov 25, 2026 - 10:12am");
		expect(formatHostTime(new Date(2026, 10, 25, 0, 5))).toBe("Nov 25, 2026 - 12:05am");
		expect(formatHostTime(new Date(2026, 10, 25, 12, 0))).toBe("Nov 25, 2026 - 12:00pm");
		expect(formatHostTime(new Date(2026, 0, 3, 23, 59))).toBe("Jan 3, 2026 - 11:59pm");
	});

	test("an unparseable timestamp prints unknown instead of NaN", () => {
		expect(formatHostTime("not a date")).toBe("unknown");
	});
});

describe("recordHostLoad", () => {
	beforeEach(() => resetHostLoadsForTest(1_000));

	test("a reload becomes the latest load and is appended to the session", () => {
		const manager = SessionManager.inMemory();
		recordHostLoad(manager, "skills", "reload-plugins", 5_000);
		expect(currentHostLoads().get("skills")).toEqual({ at: 5_000, trigger: "reload-plugins" });
		expect(currentHostLoads().get("extensions")).toEqual({ at: 1_000, trigger: "cli" });
		const events = manager.getEntries().filter(entry => entry.type === "host_event");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "skills", trigger: "reload-plugins" });
	});

	test("a start-up load updates the process record without writing an entry", () => {
		const manager = SessionManager.inMemory();
		recordHostLoad(manager, "omp", "cli", 2_000);
		expect(currentHostLoads().get("omp")).toEqual({ at: 2_000, trigger: "cli" });
		expect(manager.getEntries().some(entry => entry.type === "host_event")).toBe(false);
	});
});

describe("lifecycleSections", () => {
	test("lists reloads and resumes newest first, and goals newest first with their source", () => {
		const manager = SessionManager.inMemory();
		manager.appendHostEvent("resume", "cli");
		manager.appendHostEvent("skills", "reload-plugins");
		manager.appendHostEvent("resume", "command");
		manager.appendHostEvent("extensions", "hot-reload");
		const entries = manager.getEntries();
		const sections = lifecycleSections({
			createdAt: new Date(2026, 10, 25, 9, 0).toISOString(),
			loads: new Map([["omp", { at: new Date(2026, 10, 25, 9, 1).getTime(), trigger: "cli" }]]),
			entries,
			goals: [
				{ source: "user", at: new Date(2026, 10, 25, 9, 30).getTime(), goal: "older" },
				{ source: "autogoal", at: new Date(2026, 10, 25, 10, 0).getTime(), goal: "newer" },
			],
		});
		const byHead = Object.fromEntries(sections.map(section => [section.head, section]));

		expect(byHead.Lifecycle.rows).toEqual([
			{ key: "Created", value: "Nov 25, 2026 - 9:00am" },
			{ key: "Omp loaded", value: "Nov 25, 2026 - 9:01am, cli" },
		]);
		expect(byHead["Reload history"].rows.map(row => row.value)).toEqual([
			"extensions, hot-reload",
			"skills, reload-plugins",
		]);
		expect(byHead["Resume history"].rows.map(row => row.value)).toEqual(["command", "cli"]);
		expect(byHead.Goals.rows.map(row => row.value)).toEqual(["newer", "older"]);
		expect(byHead.Goals.rows[0].key).toBe("autogoal, Nov 25, 2026 - 10:00am");
	});

	test("an empty session says so instead of printing an empty block", () => {
		const sections = lifecycleSections({
			createdAt: new Date(2026, 10, 25, 9, 0).toISOString(),
			loads: new Map(),
			entries: [],
			goals: [],
		});
		expect(sections.find(section => section.head === "Reload history")).toMatchObject({
			rows: [],
			empty: "None this session",
		});
		expect(sections.find(section => section.head === "Resume history")).toMatchObject({
			rows: [],
			empty: "Never resumed",
		});
	});
});
