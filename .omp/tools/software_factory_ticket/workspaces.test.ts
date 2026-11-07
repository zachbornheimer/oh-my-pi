/**
 * The checkout roots a workspace covers, against where ZYS work actually lives: ZYS tickets target repositories under
 * `~/Developer/Zysys` (webmaster-deploy, ansible-infra) and SAH repositories under `~/Developer/Software-Automation-Holdings`,
 * both of which exist on the machine that runs the work (observed 2026-11-04: ZYS-2617 and the webmaster tickets were worked
 * from `~/Developer/Personal` alone).
 *

 * the module because vitest.config.ts collects only `test/**` and `webmaster-site/**`, and vitest cannot load `bun:test`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  assertKnownOrg,
  checkoutRootFor,
  primaryRoot,
  WORKSPACES,
  workspaceOfTeam,
} from "./workspaces.js";

const PERSONAL_ROOT = join(homedir(), "Developer", "Personal");
const ZYSYS_ROOT = join(homedir(), "Developer", "Zysys");
const SAH_ROOT = join(homedir(), "Developer", "Software-Automation-Holdings");

describe("the ZYS workspace roots", () => {
  it("cover where ZYS work actually lives: Personal, Zysys and the SAH roots", () => {
    const zys = workspaceOfTeam("ZYS");
    expect(zys.roots).toEqual([PERSONAL_ROOT, ZYSYS_ROOT, SAH_ROOT]);
  });

  it("keep the primary root for the workspace's own organisation, and route a SAH organisation to the SAH root", () => {
    const zys = workspaceOfTeam("ZYS");
    expect(primaryRoot(zys)).toBe(PERSONAL_ROOT);
    expect(checkoutRootFor(zys, "zachbornheimer")).toBe(PERSONAL_ROOT);
    expect(checkoutRootFor(zys, "Software-Automation-Holdings-LLC")).toBe(SAH_ROOT);
  });

  it("keep the third-party-organisation refusal intact", () => {
    expect(() => assertKnownOrg("Software-Automation-Holdings-LLC")).not.toThrow();
    expect(() => assertKnownOrg("zachbornheimer")).not.toThrow();
    expect(() => assertKnownOrg("some-third-party-org")).toThrow(/third-party GitHub organisation/);
  });

  it("holds one entry per workspace, each with at least the roots it works from", () => {
    expect(WORKSPACES.map((workspace) => workspace.team)).toEqual(["SAH", "ZYS"]);
    expect(workspaceOfTeam("SAH").roots).toEqual([SAH_ROOT]);
  });
});
