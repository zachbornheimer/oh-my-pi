import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { selectModel } from "./select.js";

const DESCRIPTION = [
  "Rank the semantic models agentmux has registered that can answer a task, best fit first. Use it to choose a decision or language model route for a task prompt; it asks no model and does not call the winner. These are agentmux's routes (TypeSafe Jev, Ollama, OpenRouter), not omp's own model roles.",
  "Use `classify_prompt_parts` for the strength a prompt needs, `task_class` for the kind of work.",
  'Call `{"text":"write a summary"}`. Text is trimmed; blank is refused (`select_model requires a task prompt`).',
  "A prompt with a word starting `descri`, `write`/`rewrite`/`writing`, `generat`, `llm` or `text` (any case) needs a language model, any other prompt a decision model.",
  "`AGENTMUX_LANGUAGE_MODEL` / `AGENTMUX_DECISION_MODEL` (comma-separated ids, rank order, blank is no pin) pin the answer for their kind; an unknown pinned id fails `select a model for \"<text>\": unknown ... model \"<id>\"`.",
  "Unpinned: language is `openrouter/auto`; decision is the ranked list with `openrouter/~typesafe/jev-latest` first and `ollama/nimble` last, free or named-only models never ranked unnamed.",
  "Reads only the environment; no network, nothing written.",
  "Returns `{Candidates: string[]}`, best first.",
].join(" ");

const factory: CustomToolFactory = (pi) => {
  const z = pi.zod;
  return {
    name: "select_model",
    label: "Select model",
    description: DESCRIPTION,
    parameters: z.object({
      text: z.string().describe("The task prompt to pick models for. Trimmed; blank is refused. Wording about describing, writing, generating, an llm or text selects language models; anything else decision models."),
    }),

    async execute(_toolCallId, params) {
      const output = selectModel(params.text, process.env);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  };
};

export default factory;
