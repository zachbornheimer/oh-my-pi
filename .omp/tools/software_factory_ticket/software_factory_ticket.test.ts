import { describe, expect, it } from "bun:test";
import type { State } from "./schemas.js";
import { runTicket as run } from "./workflow.js";
import { blocking, checkoutPath, clean, FakeFactory, implemented, ORG, PERSONAL_ORG, pullUrl } from "./fake_world.js";

type Attempt = { status: "success"; state: State; skipped: string[]; resumed: boolean } | { status: "failed"; error: string };

/** One run of the ticket workflow, as its outcome: the final state, or the failure the run threw. */
async function runTicket(world: FakeFactory, input: { ticket: string; merge?: boolean }): Promise<Attempt> {
  try {
    const result = await run(world.ports(), { ticket: input.ticket, merge: input.merge ?? false });
    return { status: "success", ...result };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Why a run failed: the error the run threw. */
function failure(result: Attempt): string {
  return result.status === "failed" ? result.error : "the run did not fail";
}

/** The state the run answered with; the run itself must have settled, bailed or not. */
async function settled(world: FakeFactory, input: { ticket: string; merge?: boolean }): Promise<State> {
  const result = await runTicket(world, input);
  if (result.status !== "success") throw new Error(`the run failed: ${failure(result)}`);
  return result.state;
}

/** A world with one ticket in Triage. */
function worldWith(ticket = "SAH-1", overrides: Parameters<FakeFactory["addIssue"]>[1] = {}): FakeFactory {
  const world = new FakeFactory();
  world.addIssue(ticket, overrides);
  return world;
}

describe("software_factory_ticket", () => {
  it("an undecipherable ticket goes to Not Ready for Dev with the questions that block it: no repository, no worktree, no PR", async () => {
    const world = worldWith();
    world.rewrite = () => ({ decipherable: false, description: "", questions: ["Which product is meant?", "What did you expect to happen?"] });

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("undecipherable");
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    const [comment] = world.commentsOn("SAH-1");
    expect(comment).toContain("Which product is meant?");
    expect(comment).toContain("What did you expect to happen?");
    expect(world.worktrees).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.prompts.map((asked) => asked.field)).toEqual(["Rewrite"]);
    expect(world.lockHolder).toBeUndefined();
  });

  it("puts the text of the tickets skill, read at run time, in the rewrite question", async () => {
    const world = worldWith();
    world.skillText = "SKILL TEXT READ AT RUN TIME";
    world.rewrite = () => ({ decipherable: false, description: "", questions: ["Which product?"] });

    await settled(world, { ticket: "SAH-1" });

    expect(world.prompts[0]!.prompt).toContain("SKILL TEXT READ AT RUN TIME");
    expect(world.prompts[0]!.prompt).toContain("The quote page for SAH-1 is wrong.");
  });

  it("a ticket with no identifiable repository is worked without a checkout and settles from the worker's answer", async () => {
    const world = worldWith();
    world.repositoryReply = { repository: "", why: "The ticket names no product or service." };
    world.repolessWorks.push({
      outcome: "work_completed",
      summary: "The pricing question is answered on the ticket itself.",
      evidence: ["the vendor's pricing page, recorded on the ticket"],
      concerns: [],
      closeLinkedPullRequest: false,
    });

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("work_completed");
    expect(world.issue("SAH-1").status).toBe("Done");
    const [comment] = world.commentsOn("SAH-1");
    expect(comment).toContain("Done: the work is complete");
    expect(comment).toContain("The pricing question is answered on the ticket itself.");
    expect(world.workPrompts[0]).toContain("The ticket names no product or service.");
    expect(world.worktrees).toHaveLength(0);
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
  });

  it("a ticket with no repository is reviewed before it is worked without a checkout", async () => {
    const world = worldWith();
    world.repositoryReply = { repository: "", why: "The ticket names no product or service." };
    world.rootCause = {
      verdict: "real",
      workInThisCheckout: false,
      rootCause: "The finding is about the host's cron, not any checkout.",
      summary: "Real, and the work lives on the host.",
      evidence: ["the host's crontab"],
      concerns: [],
      closeLinkedPullRequest: false,
    };
    world.repolessWorks.push({
      outcome: "work_completed",
      summary: "Recorded what the host runs.",
      evidence: ["the host's cron listing, recorded on the ticket"],
      concerns: [],
      closeLinkedPullRequest: false,
    });

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("work_completed");
    expect(world.worktrees).toHaveLength(0);
    expect(world.reviewPrompts).toHaveLength(1);
    expect(world.reviewPrompts[0]).toContain("No repository was identified for this ticket");
    expect(world.reviewPrompts[0]).toContain("The ticket names no product or service.");
    // The review runs first, and its root cause is what the worker starts from.
    expect(world.events.indexOf("review SAH-1-root-cause.json")).toBeLessThan(world.events.indexOf("work"));
    expect(world.workPrompts[0]).toContain("The finding is about the host's cron, not any checkout.");
  });

  it("a pre-review that finds the report a user mistake cancels the ticket as obsolete and closes its linked PR with the reason", async () => {
    const world = worldWith("SAH-2", { attachments: [{ title: "PR", url: pullUrl(ORG, "widgets", 7) }] });
    world.addPull(ORG, "widgets", 7);
    world.rootCause = {
      verdict: "obsolete",
      workInThisCheckout: true,
      rootCause: "The report used the sandbox key against production.",
      summary: "A user mistake: the sandbox key was used against production.",
      evidence: ["docs/keys.md:3"],
      concerns: [],
      closeLinkedPullRequest: true,
    };

    const state = await settled(world, { ticket: "SAH-2" });

    expect(state.outcome).toBe("obsolete");
    expect(world.issue("SAH-2").status).toBe("Canceled");
    expect(world.pulls.get(pullUrl(ORG, "widgets", 7))!.state).toBe("CLOSED");
    expect(world.closed[0]!.comment).toContain("sandbox key");
    const [comment] = world.commentsOn("SAH-2");
    expect(comment).toContain("sandbox key");
    expect(comment).toContain("docs/keys.md:3");
    expect(comment).toContain(pullUrl(ORG, "widgets", 7));
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.pushes).toHaveLength(0);
    expect(world.created).toHaveLength(0);
  });

  it("a pre-review that finds the ticket obsolete cancels it and closes its linked open PR with the reason, even when the judge did not ask to", async () => {
    const world = worldWith("SAH-6", { description: `The legacy quote page is wrong; see ${pullUrl(ORG, "widgets", 9)}` });
    world.addPull(ORG, "widgets", 9);
    world.rootCause = {
      ...world.rootCause,
      verdict: "obsolete",
      rootCause: "",
      summary: "The legacy quote page was removed in the v3 rewrite.",
      evidence: ["src/pages/ has no quote.tsx since commit def456"],
      closeLinkedPullRequest: false,
    };

    const state = await settled(world, { ticket: "SAH-6" });

    expect(state.outcome).toBe("obsolete");
    expect(world.issue("SAH-6").status).toBe("Canceled");
    expect(world.pulls.get(pullUrl(ORG, "widgets", 9))!.state).toBe("CLOSED");
    expect(world.closed[0]!.comment).toContain("removed in the v3 rewrite");
    expect(state.closedPullRequests).toEqual([pullUrl(ORG, "widgets", 9)]);
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
  });

  it("a pre-review that finds the work already done closes the ticket Done and leaves the linked PR open unless it is redundant", async () => {
    const world = worldWith("SAH-3", { attachments: [{ title: "PR", url: pullUrl(ORG, "widgets", 8) }] });
    world.addPull(ORG, "widgets", 8);
    world.rootCause = { ...world.rootCause, verdict: "already_done", summary: "Merged in #5.", evidence: ["commit abc123"], closeLinkedPullRequest: false };

    const state = await settled(world, { ticket: "SAH-3" });

    expect(state.outcome).toBe("already_done");
    expect(world.issue("SAH-3").status).toBe("Done");
    expect(world.pulls.get(pullUrl(ORG, "widgets", 8))!.state).toBe("OPEN");
    expect(world.closed).toHaveLength(0);
  });

  it("a superseded ticket becomes a Duplicate of the superseding ticket", async () => {
    const world = worldWith("SAH-4");
    world.addIssue("SAH-9");
    world.rootCause = { ...world.rootCause, verdict: "superseded", summary: "Replaced by SAH-9.", supersededBy: "SAH-9" };

    await settled(world, { ticket: "SAH-4" });

    expect(world.issue("SAH-4").status).toBe("Duplicate");
    expect(world.issue("SAH-4").duplicateOf).toBe("SAH-9");
    expect(world.commentsOn("SAH-4")[0]).toContain("Superseded by SAH-9");
  });

  it("a superseded ticket with no superseding ticket is Canceled", async () => {
    const world = worldWith("SAH-4");
    world.rootCause = { ...world.rootCause, verdict: "superseded", summary: "Replaced by the v2 rewrite.", supersededBy: "the v2 rewrite" };

    await settled(world, { ticket: "SAH-4" });

    expect(world.issue("SAH-4").status).toBe("Canceled");
  });

  it("a pre-review that needs information sends the ticket back to Not Ready for Dev with its concerns: no PR, no work", async () => {
    const world = worldWith();
    world.rootCause = {
      verdict: "needs_info",
      workInThisCheckout: true,
      rootCause: "",
      summary: "The root cause cannot be established.",
      evidence: [],
      concerns: ["Which carrier returns the empty list?", "Is there a request id?"],
      closeLinkedPullRequest: false,
    };

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("needs_info");
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    const [comment] = world.commentsOn("SAH-1");
    expect(comment).toContain("Which carrier returns the empty list?");
    expect(comment).toContain("Is there a request id?");
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.pushes).toHaveLength(0);
  });

  it("a ready PR for pr_ready: the ticket moves to Pull Request and make_pr_mergable runs without merging by default", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ concerns: ["Rounding of totals is untested for JPY."] }));
    world.changeReviews.push(clean);

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("pr_ready");
    expect(world.created).toHaveLength(1);
    const pr = world.created[0]!;
    expect(pr.draft).toBe(false);
    expect(pr.head).toBe("sah-1");
    expect(pr.title).toContain("SAH-1");
    expect(pr.body).toContain("SAH-1");
    expect(world.pushes).toEqual(["sah-1"]);
    expect(world.issue("SAH-1").status).toBe("Pull Request");
    expect(world.commentsOn("SAH-1")[0]).toContain(pr.url);
    expect(world.mergeRuns).toEqual([{ prUrl: pr.url, merge: false }]);
    expect(world.commentsOn("SAH-1")[1]).toContain("make_pr_mergable");
    expect(world.commentsOn("SAH-1")[1]).toContain("settled approved");
    expect(world.issue("SAH-1").status).toBe("Pull Request");
    expect(state.pullRequest).toEqual({ url: pr.url, number: 100, draft: false });
  });

  it("hands the /tickets analysis to the code-improver without rewriting the ticket: its own text stands and no status is forced on it", async () => {
    const world = worldWith();
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    await settled(world, { ticket: "SAH-1" });

    expect(world.issue("SAH-1").description).toBe("The quote page for SAH-1 is wrong.");
    expect(world.implementPrompts[0]).toContain("Title of SAH-1, rewritten.");
    expect(world.implementPrompts[0]).not.toContain("The quote page for SAH-1 is wrong.");
    expect(world.linearWrites.join("\n")).not.toContain("Ready for Dev");
    expect(world.events.indexOf("implement")).toBeGreaterThan(world.events.findIndex((event) => event.includes("In Progress")));
  });

  it("passes merge: true through to make_pr_mergable", async () => {
    const world = worldWith();
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    await settled(world, { ticket: "SAH-1", merge: true });

    expect(world.mergeRuns).toEqual([{ prUrl: world.created[0]!.url, merge: true }]);
  });

  it("works on the head branch of a linked open PR instead of opening a second one, and takes a draft PR out of draft", async () => {
    const world = worldWith("SAH-5", { attachments: [{ title: "PR", url: pullUrl(ORG, "widgets", 12) }] });
    world.addPull(ORG, "widgets", 12, { isDraft: true, headRef: "zach/fix-quote", baseRef: "develop" });
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    const state = await settled(world, { ticket: "SAH-5" });

    expect(world.worktrees).toEqual([{ checkout: checkoutPath("SAH-5", "widgets"), ticket: "SAH-5", branch: "zach/fix-quote", base: "develop" }]);
    expect(world.created).toHaveLength(0);
    expect(world.pushes).toEqual(["zach/fix-quote"]);
    expect(world.pulls.get(pullUrl(ORG, "widgets", 12))!.isDraft).toBe(false);
    expect(state.pullRequest!.url).toBe(pullUrl(ORG, "widgets", 12));
    expect(world.mergeRuns[0]!.prUrl).toBe(pullUrl(ORG, "widgets", 12));
  });

  it("a blocked change gets one more implementation with the findings, and the second review decides", async () => {
    const world = worldWith();
    world.implementations.push(implemented(), implemented({ summary: "Fixed the data loss too." }));
    world.changeReviews.push(blocking("The new total drops the discount."), clean);

    const state = await settled(world, { ticket: "SAH-1" });

    expect(world.implementPrompts).toHaveLength(2);
    expect(world.implementPrompts[0]).not.toContain("The new total drops the discount.");
    expect(world.implementPrompts[1]).toContain("The new total drops the discount.");
    expect(world.reviewPrompts.filter((prompt) => prompt.includes("git diff"))).toHaveLength(2);
    expect(state.outcome).toBe("pr_ready");
    expect(world.created[0]!.draft).toBe(false);
    expect(world.issue("SAH-1").status).toBe("Pull Request");
  });

  it("a change blocked twice is remanded: a draft PR naming the ticket and the concerns, the ticket back in Not Ready with the concerns, never a third round", async () => {
    const world = worldWith();
    world.implementations.push(implemented(), implemented());
    world.changeReviews.push(blocking("The new total drops the discount."), blocking("The discount is still dropped for bundles."));

    const state = await settled(world, { ticket: "SAH-1" });

    expect(world.implementPrompts).toHaveLength(2);
    expect(state.outcome).toBe("needs_info");
    expect(world.created).toHaveLength(1);
    const pr = world.created[0]!;
    expect(pr.draft).toBe(true);
    expect(pr.title).toContain("SAH-1");
    expect(pr.body).toContain("SAH-1");
    expect(pr.body).toContain("The discount is still dropped for bundles.");
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    const [comment] = world.commentsOn("SAH-1");
    expect(comment).toContain("The discount is still dropped for bundles.");
    expect(comment).toContain(pr.url);
    expect(world.mergeRuns).toHaveLength(0);
  });

  it("an implementation that needs information but changed nothing sends the ticket back with no PR", async () => {
    const world = worldWith();
    world.ahead = 0;
    world.implementations.push(implemented({ outcome: "needs_info", summary: "Cannot tell which tax region applies.", concerns: ["Which tax region applies?"] }));

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("needs_info");
    expect(world.created).toHaveLength(0);
    expect(world.pushes).toHaveLength(0);
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    expect(world.commentsOn("SAH-1")[0]).toContain("Which tax region applies?");
  });

  it("an implementation that needs information after changing things pushes a draft PR", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "needs_info", summary: "Half done.", concerns: ["Which tax region applies?"] }));

    await settled(world, { ticket: "SAH-1" });

    expect(world.created[0]!.draft).toBe(true);
    expect(world.created[0]!.body).toContain("Which tax region applies?");
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
  });

  it("a pr_ready that left no commit is a needs_info, not an empty PR", async () => {
    const world = worldWith();
    world.ahead = 0;
    world.implementations.push(implemented());

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("needs_info");
    expect(world.created).toHaveLength(0);
    expect(world.reviewPrompts.filter((prompt) => prompt.includes("git diff"))).toHaveLength(0);
    expect(world.commentsOn("SAH-1")[0]).toContain("no commit ahead");
  });

  it("an implementation that finds the work already done closes the ticket Done with no PR", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "already_done", summary: "Shipped in v2.3.", evidence: ["commit abc123"] }));

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("already_done");
    expect(world.issue("SAH-1").status).toBe("Done");
    expect(world.created).toHaveLength(0);
    expect(world.pushes).toHaveLength(0);
    expect(world.mergeRuns).toHaveLength(0);
  });

  it("an obsolete ticket is Canceled and its linked PR closed", async () => {
    const world = worldWith("SAH-6", { attachments: [{ title: "PR", url: pullUrl(ORG, "widgets", 3) }] });
    world.addPull(ORG, "widgets", 3);
    world.implementations.push(implemented({ outcome: "obsolete", summary: "The quote page was removed." }));

    await settled(world, { ticket: "SAH-6" });

    expect(world.issue("SAH-6").status).toBe("Canceled");
    expect(world.pulls.get(pullUrl(ORG, "widgets", 3))!.state).toBe("CLOSED");
  });

  it("a lock held by another run ends the run busy without a single Linear write", async () => {
    const world = worldWith();
    world.lockHolder = "another-run";

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("busy");
    expect(state.busyHeldBy).toEqual({ runId: "another-run", ticket: "SAH-9" });
    expect(world.linearWrites).toEqual([]);
    expect(world.events).toEqual([]);
    expect(world.issue("SAH-1").status).toBe("Triage");
    expect(world.lockHolder).toBe("another-run");
  });

  it("frees the lock whether the run settles or fails", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "already_done" }));
    await settled(world, { ticket: "SAH-1" });
    expect(world.lockHolder).toBeUndefined();

    const failing = worldWith();
    failing.rewrite = () => {
      throw new Error("the model is down");
    };
    const result = await runTicket(failing, { ticket: "SAH-1" });
    expect(result.status).toBe("failed");
    expect(failing.lockHolder).toBeUndefined();
  });

  it("a Linear write that the read-back does not show fails the run instead of going on", async () => {
    const world = worldWith();
    world.dropLinearWrites = true;

    const result = await runTicket(world, { ticket: "SAH-1" });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("Linear write not visible on SAH-1");
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.lockHolder).toBeUndefined();
  });

  it("a comment the read-back does not show fails the run, even though the status write before it landed", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "already_done" }));
    world.dropCommentWrites = true;

    const result = await runTicket(world, { ticket: "SAH-1" });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("no comment on it carries the body that was posted");
    expect(world.issue("SAH-1").status).toBe("Done");
    expect(world.commentsOn("SAH-1")).toEqual([]);
    expect(world.lockHolder).toBeUndefined();
  });

  it("re-reads a write that Linear's lagging replica has not caught up with yet", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "already_done" }));
    // The live run on SAH-11420 saved its description and the next read still carried the old one.
    world.staleReads = 2;

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("already_done");
    expect(world.issue("SAH-1").status).toBe("Done");
    expect(world.commentsOn("SAH-1")).toHaveLength(1);
    expect(world.sleeps.length).toBeGreaterThanOrEqual(4);
    expect(new Set(world.sleeps)).toEqual(new Set([1_250]));
  });

  it("fails a write the lagging replica never catches up with, and names the field it asked for", async () => {
    const world = worldWith();
    world.staleReads = Number.POSITIVE_INFINITY;

    const result = await runTicket(world, { ticket: "SAH-1" });

    expect(result.status).toBe("failed");
    expect(failure(result)).toContain('Linear write not visible on SAH-1: asked for status "In Progress"');
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.lockHolder).toBeUndefined();
  });

  it("works a ZYS ticket in its own workspace: an undecipherable one is left in Initial Ticket Review", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-1", { status: "Unreviewed" });
    world.rewrite = () => ({ decipherable: false, description: "", questions: ["Which project is meant?"] });

    const state = await settled(world, { ticket: "ZYS-1" });

    expect(state.outcome).toBe("undecipherable");
    expect(world.issue("ZYS-1").status).toBe("Initial Ticket Review");
    expect(world.commentsOn("ZYS-1")[0]).toContain("Which project is meant?");
  });

  it("routes every Linear call to the workspace the identifier names: ZYS to linear-personal, SAH to linear-sah", async () => {
    const zys = new FakeFactory();
    zys.addIssue("ZYS-1", { status: "Unreviewed" });
    zys.implementations.push(implemented({ outcome: "already_done" }));
    const sah = worldWith();
    sah.implementations.push(implemented({ outcome: "already_done" }));

    await settled(zys, { ticket: "ZYS-1" });
    await settled(sah, { ticket: "SAH-1" });

    expect(zys.linearCalls.length).toBeGreaterThan(0);
    expect(zys.linearCalls.every((call) => call.team === "ZYS")).toBe(true);
    expect(sah.linearCalls.every((call) => call.team === "SAH")).toBe(true);
    expect(zys.linearCalls.map((call) => call.tool)).toContain("listStatuses");
  });

  it("a ZYS remand lands in Initial Ticket Review, and its draft PR names that status", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-2", { status: "Ready for Development" });
    world.repositoryReply = { repository: "capabilities", why: "The ticket names the capabilities CLI." };
    world.implementations.push(implemented(), implemented());
    world.changeReviews.push(blocking("The retry loop still sleeps twice."), blocking("The retry loop sleeps twice on 429."));

    const state = await settled(world, { ticket: "ZYS-2" });

    expect(state.outcome).toBe("needs_info");
    expect(world.issue("ZYS-2").status).toBe("Initial Ticket Review");
    expect(world.worktrees[0]!.checkout).toBe(checkoutPath("ZYS-2", "capabilities"));
    expect(world.created[0]!.draft).toBe(true);
    expect(world.created[0]!.org).toBe(PERSONAL_ORG);
    expect(world.created[0]!.body).toContain("sent back to Initial Ticket Review");
  });

  it("a ZYS pr_ready opens its pull request in the personal organisation and moves the ticket to Pull Request", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-3", { status: "Ready for Development" });
    world.repositoryReply = { repository: "capabilities", why: "The ticket names the capabilities CLI." };
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    const state = await settled(world, { ticket: "ZYS-3" });

    expect(state.outcome).toBe("pr_ready");
    expect(world.created[0]).toMatchObject({ org: PERSONAL_ORG, repo: "capabilities", draft: false });
    expect(world.issue("ZYS-3").status).toBe("Pull Request");
    expect(world.mergeRuns).toEqual([{ prUrl: world.created[0]!.url, merge: false }]);
  });

  it("a ZYS ticket whose pull request is merged closes as Done with the evidence, its repository under the personal root", async () => {
    const world = new FakeFactory();
    const merged = pullUrl(PERSONAL_ORG, "capabilities", 12);
    world.addIssue("ZYS-4", { status: "Unreviewed", attachments: [{ title: "PR", url: merged }] });
    world.addPull(PERSONAL_ORG, "capabilities", 12, { state: "MERGED" });
    world.rootCause = {
      ...world.rootCause,
      verdict: "already_done",
      summary: "Merged in #12.",
      evidence: [`commit 9f2c1a1, ${merged}`],
      closeLinkedPullRequest: false,
    };

    const state = await settled(world, { ticket: "ZYS-4" });

    expect(state.outcome).toBe("already_done");
    expect(state.repository).toMatchObject({
      org: PERSONAL_ORG,
      name: "capabilities",
      checkout: checkoutPath("ZYS-4", "capabilities"),
    });
    expect(world.issue("ZYS-4").status).toBe("Done");
    const [comment] = world.commentsOn("ZYS-4");
    expect(comment).toContain("commit 9f2c1a1");
    expect(comment).toContain(merged);
    expect(world.pulls.get(merged)!.state).toBe("MERGED");
    expect(world.mergeRuns).toHaveLength(0);
  });

  it("a ZYS ticket naming a repository GitHub does not have is worked without a checkout, told what GitHub said, and settles from the worker's answer", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-5", { status: "Unreviewed" });
    world.repositoryReply = { repository: "obsidian-backup", why: "The ticket names the obsidian backup." };
    // The live ZYS-* run of 2026-10-29 died here: `gh repo clone zachbornheimer/obsidian-backup` could not resolve the repository.
    world.unavailableRepos.push(`${PERSONAL_ORG}/obsidian-backup`);
    world.repolessWorks.push({
      outcome: "work_completed",
      summary: "Found where the backups really live and recorded it on the ticket.",
      evidence: ["the host's cron listing, recorded on the ticket"],
      concerns: [],
      closeLinkedPullRequest: false,
    });

    const state = await settled(world, { ticket: "ZYS-5" });

    expect(state.outcome).toBe("work_completed");
    expect(world.issue("ZYS-5").status).toBe("Done");
    expect(world.workPrompts[0]).toContain(`The repository ${PERSONAL_ORG}/obsidian-backup the ticket names could not be fetched`);
    expect(world.workPrompts[0]).toContain("GraphQL: Could not resolve to a Repository with the name 'zachbornheimer/obsidian-backup'");
    expect(world.clones).toHaveLength(0);
    expect(world.worktrees).toHaveLength(0);
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.lockHolder).toBeUndefined();
  });

  it("a repository question answered in prose is worked without a checkout instead of failing the run", async () => {
    const world = new FakeFactory();
    world.addIssue("ZYS-5", { status: "Unreviewed" });
    // The live ZYS-2610 run of 2026-11-04 died here: the model answered the question in prose, the adapter refused the
    // answer for holding no JSON object, and the run failed instead of working the ticket without a checkout.
    world.repositoryReply = "The ticket's work belongs in capability-replicas/mastra, which holds the webmaster flows.";
    world.repolessWorks.push({
      outcome: "work_completed",
      summary: "Worked the ticket without a checkout.",
      evidence: ["the ticket's own comment"],
      concerns: [],
      closeLinkedPullRequest: false,
    });

    const state = await settled(world, { ticket: "ZYS-5" });

    expect(state.outcome).toBe("work_completed");
    expect(world.workPrompts[0]).toContain("came back in a form this run could not read");
    expect(world.worktrees).toHaveLength(0);
    expect(world.created).toHaveLength(0);
  });

  it("a linked pull request naming a repository GitHub does not have is the same repo-less work", async () => {
    const world = worldWith("SAH-7", { attachments: [{ title: "PR", url: pullUrl(ORG, "obsidian-notes", 2) }] });
    world.addPull(ORG, "obsidian-notes", 2);
    world.unavailableRepos.push(`${ORG}/obsidian-notes`);
    world.repolessWorks.push({ outcome: "work_completed", summary: "Worked without the checkout.", evidence: [], concerns: [], closeLinkedPullRequest: false });

    const state = await settled(world, { ticket: "SAH-7" });

    expect(state.outcome).toBe("work_completed");
    expect(world.issue("SAH-7").status).toBe("Done");
    expect(world.workPrompts[0]).toContain(`The repository ${ORG}/obsidian-notes the ticket names could not be fetched`);
    expect(world.clones).toHaveLength(0);
    expect(world.worktrees).toHaveLength(0);
    expect(world.created).toHaveLength(0);
  });

  it("a worktree that cannot be opened because the repository is gone upstream is blocked with what would unblock it, not a failed run", async () => {
    const world = worldWith("SAH-3");
    // The checkout is local, so nothing is cloned; the worktree's fetch finds the repository gone from GitHub.
    world.unavailableWorktrees.push(`${ORG}/widgets`);

    const state = await settled(world, { ticket: "SAH-3" });

    expect(state.outcome).toBe("blocked");
    expect(state.linearStatus).toBe("Not Ready for Dev");
    expect(world.issue("SAH-3").status).toBe("Not Ready for Dev");
    const comments = world.commentsOn("SAH-3");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("could not be opened");
    expect(comments[0]).toContain("would unblock this run");
    expect(world.clones).toHaveLength(0);
    expect(world.worktrees).toHaveLength(0);
    expect(world.implementPrompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.lockHolder).toBeUndefined();
  });

  it("an identifier whose prefix is no workspace fails the run and names the workspaces the factory knows", async () => {
    const world = new FakeFactory();
    world.addIssue("ZZZ-1");

    const result = await runTicket(world, { ticket: "ZZZ-1" });

    expect(result.status).toBe("failed");
    expect(failure(result)).toContain("SAH");
    expect(failure(result)).toContain("ZYS");
    expect(world.events).toEqual([]);
    expect(world.lockHolder).toBeUndefined();
  });

  it("a status Linear does not have fails the run and names the statuses it has", async () => {
    const world = worldWith();
    const ports = world.ports();
    ports.linear.listStatuses = async () => [{ id: "1", name: "Triage" }];
    let result: Attempt;
    try {
      result = { status: "success", ...(await run(ports, { ticket: "SAH-1", merge: false })) };
    } catch (error) {
      result = { status: "failed", error: (error as Error).message };
    }

    expect(result.status).toBe("failed");
    expect(failure(result)).toContain('no status named "In Progress"');
    expect(failure(result)).toContain("the team has: Triage");
  });
  it("hands a published pull request to fix_red_ci before the settle comment, and only merges a green one", async () => {
    const world = worldWith();
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("pr_ready");
    const pr = world.created[0]!;
    expect(world.fixRedCiRuns).toEqual([pr.url]);
    expect(world.events.indexOf("git.push")).toBeLessThan(world.events.indexOf("fixRedCi"));
    expect(world.events.indexOf("fixRedCi")).toBeLessThan(
      world.events.findIndex((event) => event.startsWith("linear.saveComment")),
    );
    expect(world.mergeRuns).toEqual([{ prUrl: pr.url, merge: false }]);
  });

  it("hands a linked pull request the run continued — not just the one it would have published — to fix_red_ci", async () => {
    const world = worldWith("SAH-5", { attachments: [{ title: "PR", url: pullUrl(ORG, "widgets", 12) }] });
    world.addPull(ORG, "widgets", 12, { isDraft: true, headRef: "zach/fix-quote", baseRef: "develop" });
    world.implementations.push(implemented());
    world.changeReviews.push(clean);

    await settled(world, { ticket: "SAH-5" });

    expect(world.fixRedCiRuns).toEqual([pullUrl(ORG, "widgets", 12)]);
  });

  it("a draft PR fix_red_ci cannot green never blocks a remand: needs_info settles with the draft PR", async () => {
    const world = worldWith();
    world.implementations.push(implemented(), implemented());
    world.changeReviews.push(blocking("The new total drops the discount."), blocking("The discount is still dropped for bundles."));
    world.fixRedCiReport = { green: false, report: "The pull request is a draft, so CI will not run." };

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("needs_info");
    expect(world.created[0]!.draft).toBe(true);
    expect(world.fixRedCiRuns).toEqual([world.created[0]!.url]);
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    expect(world.mergeRuns).toHaveLength(0);
  });

  it("a pull request fix_red_ci cannot green settles the run blocked, with no merge and no pr_ready", async () => {
    const world = worldWith();
    world.implementations.push(implemented());
    world.changeReviews.push(clean);
    world.fixRedCiReport = { green: false, report: "The round budget is gone: 12 rounds over this pull request's life." };

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("blocked");
    expect(world.issue("SAH-1").status).toBe("Not Ready for Dev");
    const [comment] = world.commentsOn("SAH-1");
    expect(comment).toContain("Blocked: this run cannot finish it as dispatched");
    expect(comment).toContain(world.created[0]!.url);
    expect(comment).toContain("round budget is gone");
    expect(world.mergeRuns).toHaveLength(0);
  });

  it("runs fix_red_ci on no pull request when the run never published one", async () => {
    const world = worldWith();
    world.implementations.push(implemented({ outcome: "already_done", summary: "Shipped in v2.3.", evidence: ["commit abc123"] }));

    const state = await settled(world, { ticket: "SAH-1" });

    expect(state.outcome).toBe("already_done");
    expect(world.fixRedCiRuns).toEqual([]);
  });
});
