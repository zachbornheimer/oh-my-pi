import { describe, expect, test } from "bun:test";
import { declaredAtaskChecks } from "../src/task/atask";

const COMMAND = "run: bun readiness.ts --session 01a20e91";

describe("declaredAtaskChecks", () => {
	test("files a host's durable commands instead of its in-process closures", () => {
		const proof = async () => true;
		const regression = async () => true;
		expect(declaredAtaskChecks({ proof, regression, proofCommand: COMMAND, regressionCommand: COMMAND })).toEqual({
			proof: COMMAND,
			regression: COMMAND,
		});
	});

	test("keeps live closures when a host declares no durable command", () => {
		const proof = async () => true;
		const regression = async () => false;
		expect(declaredAtaskChecks({ proof, regression })).toEqual({ checks: { proof, regression } });
	});

	test("keeps live closures when only one durable command is declared", () => {
		const proof = async () => true;
		const regression = async () => true;
		expect(declaredAtaskChecks({ proof, regression, proofCommand: COMMAND })).toEqual({
			checks: { proof, regression },
		});
	});
});
