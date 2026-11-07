/**
 * The read-back equality of a saved Linear body, for the two ways Linear renders an issue mention: the paired
 * `<issue …>ZYS-123</issue>` and the plain-text mention it stores as the self-closing
 * `<issue id="…" label="ZYS-123" href="…"/>` (observed killing four of six real-backlog runs on 2026-11-04: the tag was the
 * only difference between what was saved and what was read back), and the words a read-back disagreement is thrown in.
 */
import { describe, expect, it } from "bun:test";
import type { FactoryPorts } from "./ports.js";
import type { Issue, IssueSummary } from "./schemas.js";
import { readerDifference, readerWords, sameWords, writeTicketAndReadBack } from "./steps_close.js";
import { listEligibleTickets } from "./steps_intake.js";
import { WORKSPACES, workspaceOfTeam } from "./workspaces.js";

/** The self-closing mention tag as Linear actually stores a plain-text issue reference. */
const MENTION_TAG = '<issue id="0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d" label="ZYS-1690" href="https://linear.app/zys/issue/ZYS-1690"/>';

/** The factory template the run saves: the mention is plain text, and the label appears in the prose too. */
const WRITTEN =
  "## Evidence\n- Split from ZYS-1690; the pricing work ZYS-1690 tracks is due Friday.";

/** What Linear answers on the read-back: the mention is now the self-closing tag, the prose mention unchanged. */
const READ = `## Evidence\n- Split from ${MENTION_TAG}; the pricing work ZYS-1690 tracks is due Friday.`;

describe("a plain-text mention Linear stores as a self-closing issue tag", () => {
  it("reads as what was written, so the run's own successful write passes the read-back", () => {
    expect(sameWords(READ, WRITTEN)).toBe(true);
  });

  it("is the only difference between the two bodies, and the failure message names no difference", () => {
    expect(readerDifference(READ, WRITTEN)).toBe("");
  });

  it("keeps the tag's label, which also appears in the prose, exactly once", () => {
    expect(readerWords(READ)).toBe(readerWords(WRITTEN));
    expect(readerWords(MENTION_TAG)).toBe(readerWords("ZYS-1690"));
    expect(readerWords(MENTION_TAG)).not.toContain("issueid");
  });

  it("still reads a real difference when the label differs", () => {
    const other = READ.replace(/label="ZYS-1690"/, 'label="ZYS-1691"');
    expect(sameWords(other, WRITTEN)).toBe(false);
    expect(readerDifference(other, WRITTEN)).toContain("first differing at");
  });

  it("keeps the paired tag and markdown link normalisations it already had", () => {
    expect(
      sameWords("see [the issue](https://linear.app/x)", 'see <issue id="u" href="…">the issue</issue>'),
    ).toBe(true);
    expect(sameWords("org/widgets#123", "#123")).toBe(true);
  });
});

describe("readerDifference", () => {
  it("says nothing when the two bodies read the same", () => {
    expect(readerDifference("one two three", "one two three")).toBe("");
    expect(
      readerDifference("see [the issue](https://linear.app/x)", 'see <issue id="u" href="…">the issue</issue>'),
    ).toBe("");
  });

  it("names both lengths and the first difference, with a window around it", () => {
    const saved = "the whole paragraph is here and then goes on";
    const readBack = "the whole paragraph is here and then stops";
    const said = readerDifference(readBack, saved);
    const words = (text: string) => text.replace(/[^a-zA-Z0-9]+/g, "");
    expect(said).toContain(`${words(saved).length} characters were saved`);
    expect(said).toContain(`${words(readBack).length} read back`);
    expect(said).toContain("first differing at");
    expect(said).toContain("goeson");
    expect(said).toContain("stops");
  });
});

describe("writeTicketAndReadBack", () => {
  const workspace = workspaceOfTeam("ZYS");

  function ports(description: string) {
    const issue = (body: string): Issue => ({
      identifier: "ZYS-2378",
      title: "template",
      description: body,
      status: "Ready for Dev",
      priority: 0,
      createdAt: "2026-11-03T00:00:00.000Z",
      url: "https://linear.app/x/issue/ZYS-2378",
      gitBranchName: "zys-2378",
      attachments: [],
    });
    return {
      linear: {
        listStatuses: async () => [{ id: "status-ready", name: "Ready for Dev" }],
        saveIssue: async () => undefined,
        getIssue: async () => issue(description),
      },
      sleep: async () => {},
    } as unknown as Parameters<typeof writeTicketAndReadBack>[0];
  }

  it("names the difference when the read-back description is another body", async () => {
    const failure = await writeTicketAndReadBack(ports("the old problem, untouched"), {
      workspace,
      ticket: "ZYS-2378",
      description: "the rewritten template",
      status: "Ready for Dev",
    }).then(
      () => undefined,
      (error: Error) => error,
    );
    if (failure === undefined) throw new Error("expected the read-back disagreement to throw");
    expect(failure.message).toContain(
      "Linear write not visible on ZYS-2378: the read-back description is not the one that was saved",
    );
    expect(failure.message).toContain('wrote "therewrittentemplate"');
    expect(failure.message).toContain('read "theoldproblemuntouched"');
  });

  it("answers the issue when the read-back shows the write", async () => {
    const read = await writeTicketAndReadBack(ports("the rewritten template"), {
      workspace,
      ticket: "ZYS-2378",
      description: "the rewritten template",
      status: "Ready for Dev",
    });
    expect(read.description).toBe("the rewritten template");
  });
});

const ZYS = WORKSPACES.find((workspace) => workspace.team === "ZYS")!;
const SAH = WORKSPACES.find((workspace) => workspace.team === "SAH")!;

const summary = (identifier: string, priority: number, createdAt: string): IssueSummary => ({
  identifier,
  status: "Unreviewed",
  priority,
  createdAt,
});

/** A linear port whose `listIssues` answers from `byTeam`, and throws `failure` for a workspace that names one. */
function linearPort(
  byTeam: Record<string, IssueSummary[]>,
  failure?: { team: string; error: Error },
): Pick<FactoryPorts, "linear"> {
  const listIssues = async (workspace: { team: string }): Promise<IssueSummary[]> => {
    if (failure !== undefined && workspace.team === failure.team) throw failure.error;
    return byTeam[workspace.team] ?? [];
  };
  return { linear: { listIssues } as unknown as FactoryPorts["linear"] };
}

describe("listing the tickets a sweep works", () => {
  it("skips a workspace whose Linear has no such project instead of failing the sweep", async () => {
    const ports = linearPort(
      { [ZYS.team]: [summary("ZYS-1732", 2, "2026-11-01T00:00:00.000Z")] },
      { team: SAH.team, error: new Error('gateway linear-sah/list_issues: Error: Could not find project "AI Tooling"') },
    );

    expect(await listEligibleTickets(ports, { project: "AI Tooling", limit: 5 })).toEqual(["ZYS-1732"]);
  });

  it("keeps every workspace it can read, in priority then age order", async () => {
    const ports = linearPort({
      [ZYS.team]: [summary("ZYS-40", 0, "2026-10-01T00:00:00.000Z"), summary("ZYS-41", 1, "2026-11-01T00:00:00.000Z")],
      [SAH.team]: [summary("SAH-7", 1, "2026-09-01T00:00:00.000Z")],
    });

    // Priority 1 before no-priority, and the older of the two priority-1 tickets first.
    expect(await listEligibleTickets(ports, { limit: 5 })).toEqual(["SAH-7", "ZYS-41", "ZYS-40"]);
  });

  it("propagates a failure that is not a missing project", async () => {
    const ports = linearPort(
      { [ZYS.team]: [] },
      { team: SAH.team, error: new Error("gateway linear-sah/list_issues: 503 Service Unavailable") },
    );

    expect(listEligibleTickets(ports, { project: "AI Tooling", limit: 5 })).rejects.toThrow(/503/);
  });
});
