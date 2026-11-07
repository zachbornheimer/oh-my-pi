import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { selectExecution } from "./select.js";

const DESCRIPTION = [
  "Plan which kind of compute should back a piece of work before any provider is named: returns the compute class, backing strategy and fallback policy. It plans only; it never runs the work, never calls a model and never claims success. Use it when deciding how work should be executed; use `select_model` to pick a model.",
  'Call `{"capability":"work","shape":"implementation","maturity":"production","verifier":"weak","required_tools":["git"],"prior":{"class":"generative","failed":true,"no_new_information":true}}`.',
  "`capability` is required (blank is refused). `shape` is deterministic, classification, selection, decomposition, implementation or description; an unknown or missing shape is refused naming it. `maturity` is draft, working (default) or production. `verifier` is none (default), weak or strong. Compute classes: deterministic, structured_inference, generative, native_agent, human.",
  "`human_approval` or `credentials` forces human. Otherwise `constraints.require_class` decides, otherwise the shape: deterministic stays deterministic, classification/selection/decomposition are structured_inference, implementation/description are generative.",
  "A forced class that disagrees with `require_class` is refused. A class in `constraints.forbid` is skipped, and so is `prior.class` when it failed with `no_new_information`; when nothing is left the call is refused naming the base, the forbidden list and the stuck flag. Unknown class, maturity or verifier names are refused.",
  'Returns `{compute_class, strategy:{kind, tools?, permissions?} (sorted, de-duplicated), rationale[], fallback:{same_class_retries (1, or 0 for human or an already-failed class), retry_needs_new_information, escalate_to[], on_exhausted:"escalate"|"blocked"}, gates?:["human_review"] (production without a strong verifier), status:"selected"}`. Pure and read-only.',
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  const text = (description: string) => z.string().nullable().optional().describe(description);
  const list = (description: string) => z.array(z.string()).nullable().optional().describe(description);
  const flag = (description: string) => z.boolean().nullable().optional().describe(description);
  return {
    name: "select_execution",
    label: "Select execution",
    description: DESCRIPTION,
    parameters: z.object({
      capability: z.string().describe("Name of the capability or work being planned. Required; blank is refused."),
      shape: z
        .string()
        .describe(
          "Kind of work: deterministic, classification, selection, decomposition, implementation or description. Anything else is refused.",
        ),
      maturity: text("How finished the result must be: draft, working or production. Omitted means working."),
      verifier: text("How strongly the result can be checked: none, weak or strong. Omitted means none."),
      required_tools: list("Tools the work needs; returned sorted and de-duplicated in the strategy."),
      permissions: list("Permissions the work needs; returned sorted and de-duplicated in the strategy."),
      human_approval: flag("True when explicit human approval is required; forces the human class. Omitted means false."),
      credentials: flag("True when credentials are needed; forces the human class. Omitted means false."),
      prior: z
        .object({
          class: text("Compute class of the earlier attempt."),
          failed: flag("Whether the earlier attempt failed; a failed class gets no same-class retry."),
          no_new_information: flag("Whether it gained no new information; with failed, its class is skipped."),
        })
        .nullable()
        .optional()
        .describe("An earlier attempt at this work, if any. Omitted means none."),
      constraints: z
        .object({
          require_class: text("Compute class the work must use; empty means none."),
          forbid: list("Compute classes that must not be chosen or escalated to; an unknown name is refused."),
        })
        .nullable()
        .optional()
        .describe("Limits on which compute class may be chosen. Omitted means none."),
    }),

    async execute(_toolCallId, params) {
      const output = selectExecution(params);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
