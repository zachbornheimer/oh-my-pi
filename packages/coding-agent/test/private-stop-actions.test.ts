import { expect, test } from "bun:test";
import { runStopObligationAction } from "../src/session/stop-obligation-action";

test("issuer-private execution never consults model tool lookup", async () => {
  let executed = false;
  const result = await runStopObligationAction({
    action: { handler: "correct-source", args: { hash: "exact" }, basis: "basis" }, issuer: "owner",
    findHandler: (issuer, name) => issuer === "owner" && name === "correct-source" ? async args => { expect(args.hash).toBe("exact"); executed = true; } : undefined,
    registeredBy: () => { throw new Error("private action entered public registry"); },
    findTool: () => { throw new Error("private action entered public registry"); }, context: undefined,
    signal: new AbortController().signal, toolCallId: "private",
  });
  expect(result).toEqual({ kind: "ran" }); expect(executed).toBe(true);
});
test("foreign and missing private actions fail closed", async () => {
  const result = await runStopObligationAction({ action: { handler: "correct-source", args: {}, basis: "basis" }, issuer: "foreign", findHandler: () => undefined, registeredBy: () => undefined, findTool: () => undefined, context: undefined, signal: new AbortController().signal, toolCallId: "private" });
  expect(result.kind).toBe("rejected");
});
test("private action name cannot be invoked as a tool", async () => {
  let executed = false;
  const result = await runStopObligationAction({ action: { tool: "correct-source", args: {}, basis: "basis" }, issuer: "owner", findHandler: () => async () => { executed = true; }, registeredBy: () => undefined, findTool: () => undefined, context: undefined, signal: new AbortController().signal, toolCallId: "direct" });
  expect(result.kind).toBe("rejected"); expect(executed).toBe(false);
});
