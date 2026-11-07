/** Resolves one ticket input (an atask id, a Linear identifier, or both) into the specifics a run works against. */

/** What a ticket's filing needs from the board: file or reuse one objective. */
export interface AtaskFilePort {
  fileOrReuse(
    project: string | undefined,
    item: {
      readonly groupKey: string;
      readonly title: string;
      readonly outcome: string;
      readonly proof: string;
      readonly regression: string;
    },
  ): Promise<{ readonly id: string; readonly reused: boolean }>;
}

/** What a Linear ticket names: one issue of one workspace, by its identifier. */
export interface LinearTicket {
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  /** The ticket's own sub-issue identifiers, in board order. */
  readonly subIssues: readonly string[];
}

/** What one resolved ticket's work runs against. */
export interface TicketSpecifics {
  readonly title: string;
  /** The ticket body and its acceptance lines, as one text block the implementer reads. */
  readonly body: string;
  readonly worktree: string;
  /** The atask objective ids this ticket filed, the ticket's own first. */
  readonly ataskIds: readonly string[];
  readonly linearIdentifier?: string;
}

/** Reads one Linear issue with its sub-issues. The identifier is Linear's, like ENG-123. */
export interface LinearPort {
  issue(identifier: string): Promise<LinearTicket>;
  /** Posts one comment on the issue; the ticket carries the atask ids this way. */
  comment(identifier: string, body: string): Promise<void>;
}

export interface TicketResolver {
  resolve(input: { readonly ataskId?: string; readonly linearTicket?: string }): Promise<TicketSpecifics>;
}

/** The default group key for a Linear ticket's own objective: stable, so refiling reuses. */
export function linearGroupKey(identifier: string): string {
  return `linear-${identifier.toLowerCase()}`;
}

/** The one text block an implementer reads: the ticket, then each sub-issue's. */
export function implementerBrief(ticket: LinearTicket, subs: readonly LinearTicket[]): string {
  const subText = subs
    .map((sub, index) => `\n\nSub-issue ${index + 1} (${sub.identifier}): ${sub.title}\n${sub.description}`)
    .join("");
  return `# ${ticket.identifier}: ${ticket.title}\n\n${ticket.description}${subText}`;
}

/** The placeholder check for a ticket whose only outcome is its own resolution. */
const RESOLVE_CHECK = "run: echo resolve_ticket";

/** The marker a Linear ticket carries when an atask objective already mirrors it. */
const ATASK_MARKER = /atask-id:\s*(at-[a-z0-9]+)/;

/** The atask id a ticket's description already names, when it has one. */
export function markedAtaskId(description: string): string | undefined {
  return ATASK_MARKER.exec(description)?.[1];
}

/** What an atask objective tells its implementer: the outcome, then acceptance and constraints. */
export interface ShownObjective {
  readonly title: string;
  readonly outcome: string;
  readonly acceptance: readonly string[];
  readonly constraints: readonly string[];
}

/** The brief for an atask objective: outcome, acceptance lines, and constraints, each as a list. */
export function objectiveBrief(id: string, task: ShownObjective): string {
  const list = (heading: string, lines: readonly string[]) =>
    lines.length === 0 ? "" : `\n\n${heading}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
  return `# ${id}: ${task.title}\n\n${task.outcome}${list("Acceptance", task.acceptance)}${list("Constraints", task.constraints)}`;
}

/**
 * The ticket resolver: one Linear read, one atask filing per ticket and sub-issue (an objective the description already
 * marks `atask-id: at-...` is reused), one annotation comment when anything was newly filed. With no Linear ticket
 * named, the atask objective itself is the ticket. The ports are parameters so tests drive fakes.
 */
export function ticketResolver(ports: {
  readonly linear: LinearPort;
  readonly atask: AtaskFilePort;
  readonly ataskProject: string | undefined;
  readonly worktreeFor: (identifier: string) => Promise<string>;
  readonly show: (id: string) => Promise<ShownObjective>;
}): TicketResolver {
  const fileObjective = async (ticket: LinearTicket): Promise<string> => {
    const filed = await ports.atask.fileOrReuse(ports.ataskProject, {
      groupKey: linearGroupKey(ticket.identifier),
      title: `Resolve ${ticket.identifier}: ${ticket.title}`,
      outcome: `Linear ${ticket.identifier} is resolved: ${ticket.title}`,
      proof: RESOLVE_CHECK,
      regression: RESOLVE_CHECK,
    });
    return filed.id;
  };

  return {
    async resolve(input) {
      if (input.linearTicket === undefined) {
        if (input.ataskId === undefined) throw new Error("execute_ticket: name an atask id or a Linear ticket identifier");
        const task = await ports.show(input.ataskId);
        return {
          title: task.title,
          body: objectiveBrief(input.ataskId, task),
          worktree: await ports.worktreeFor(input.ataskId),
          ataskIds: [input.ataskId],
        };
      }

      const linear = ports.linear;
      const ticket = await linear.issue(input.linearTicket);
      const subs = await Promise.all(ticket.subIssues.map((id) => linear.issue(id)));
      const newlyFiled: string[] = [];
      /** The ticket's atask id: the one given or marked in its description, else a newly filed one. */
      const objectiveOf = async (subject: LinearTicket, given?: string): Promise<string> => {
        const known = given ?? markedAtaskId(subject.description);
        if (known !== undefined) return known;
        const id = await fileObjective(subject);
        newlyFiled.push(id);
        return id;
      };
      const subIds: string[] = [];
      for (const sub of subs) subIds.push(await objectiveOf(sub));
      const ownId = await objectiveOf(ticket, input.ataskId);
      if (newlyFiled.length > 0) {
        await linear.comment(ticket.identifier, `execute_ticket: atask ${[ownId, ...subIds].join(", ")}`);
      }
      return {
        title: ticket.title,
        body: implementerBrief(ticket, subs),
        worktree: await ports.worktreeFor(ticket.identifier),
        ataskIds: [ownId, ...subIds],
        linearIdentifier: ticket.identifier,
      };
    },
  };
}
