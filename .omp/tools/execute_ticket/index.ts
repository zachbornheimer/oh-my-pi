import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { runExecuteTicket } from "./execute.js";
import { withHeartbeat } from "./omp.js";

const DESCRIPTION = [
  "Execute one ticket end to end in its own git worktree: implement it, review and test it in rounds, open a pull request, then run improve-pr on it. Use for a Linear ticket or atask objective to implement and land; use `improve_pr` for an existing PR.",
  'Call `{"linearTicket":"ZYS-123","maxRounds":3,"repoRoot":"/path/to/repo"}` or `{"ataskId":"at-abc123"}`. One of `linearTicket` or `ataskId` is required. `repoRoot` defaults to the directory of the call; `maxRounds` is 1-10, default 3.',
  "Linear is read over GraphQL with `LINEAR_API_KEY_ZYS` (ZYS- tickets) or `LINEAR_API_KEY_SAH` (SAH-); another prefix or an unset key is refused. Each ticket and sub-issue gets an atask objective (an open one with the key is reused) and the ids are commented on the Linear ticket.",
  "Each round: a full omp session implements in `<repoRoot>/../.worktrees/<repo>-ticket-<id>` (branch `ticket/<id>`), the tool commits (a hook refusal feeds the next round), then code and security reviews of the whole branch diff (bare `omp -p`) run beside the gate `mise run test` (override: `EXECUTE_TICKET_TEST_COMMAND`, split on spaces, no shell). It lands only with no blocking finding and a green gate; blockers drive the next round.",
  "Landing pushes the branch, runs `gh pr create`, then the improve-pr pass, which MAY push to the PR and spends model quota. Runs minutes to hours with progress updates; NOT resumable (a rerun reuses the worktree and objectives, restarts the rounds).",
  'Returns `{ataskIds, linearIdentifier?, worktree, rounds[], prUrl?, suggestions[], status:"landed"|"exhausted", blockers[], improvePr?:{status:"complete"|"failed", ciStatus, requiresAnotherPass,...}}`. Exhausted lands nothing and lists the blockers still standing. Only improvePr.status complete with requiresAnotherPass false means the PR is done.',
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "execute_ticket",
    label: "Execute ticket",
    description: DESCRIPTION,
    parameters: z.object({
      ataskId: z.string().nullable().optional().describe("The atask objective id (at-XXXXXX) when the ticket already has one. One of ataskId or linearTicket is required."),
      linearTicket: z
        .string()
        .nullable()
        .optional()
        .describe("The Linear issue identifier, ZYS-123 or SAH-123; its sub-issues are filed and implemented with it."),
      maxRounds: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("Review rounds (code review, security review, test gate, then fixes) before the run reports exhausted. 1-10; omitted means 3."),
      repoRoot: z
        .string()
        .nullable()
        .optional()
        .describe("The repository the ticket's worktree opens in. Omitted means the directory this tool is called from."),
    }),

    async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      let phase = "starting";
      const progress = (name: string) => {
        phase = name;
        onUpdate?.({ content: [{ type: "text", text: `execute_ticket: ${name}` }], details: { phase: name } });
      };
      const output = await withHeartbeat(onUpdate, () => `execute_ticket: ${phase}`, () =>
        runExecuteTicket(params, { exec: pi.exec, cwd: pi.cwd, signal, onPhase: progress }),
      );
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
