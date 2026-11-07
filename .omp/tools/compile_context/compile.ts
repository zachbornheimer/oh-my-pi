import { Bundle, estimateTokens } from "./bundle.js";
import { requiredDurableItems } from "./durable.js";
import { evidenceId, rankEvidence } from "./evidence.js";
import {
  type CompileContextInput,
  type CompileContextResult,
  CONTEXT_BASIS,
  type ContextBudget,
  type OmittedContext,
} from "./schemas.js";
import { runeCount, trimSpace } from "./text.js";

const ERROR_PREFIX = "compile_context: ";
const REASON_BUDGET_PREFIX = "budget exceeded: ";

/** Selects a bounded, provenance-carrying bundle: required items first, then evidence by relevance while the budget allows. */
export function compileContext(input: CompileContextInput): CompileContextResult {
  validate(input);
  const bundle = new Bundle(input.budget);
  const durable = requiredDurableItems(input);
  const evidence = rankEvidence(input.evidence);
  const omitted: OmittedContext[] = [...durable.omitted, ...evidence.omitted];
  for (const item of [...durable.items, ...evidence.required]) {
    bundle.add(item);
  }
  if (bundle.overBudget()) {
    const { max_items, max_chars, max_tokens } = input.budget;
    throw new Error(
      `${ERROR_PREFIX}required context needs ${bundle.items.length} items/${bundle.chars} chars/~${
        estimateTokens(bundle.chars)
      } tokens, exceeding budget max_items=${max_items} max_chars=${max_chars} max_tokens=${max_tokens}`,
    );
  }
  for (const item of evidence.scored) {
    const dimension = bundle.exceeded(runeCount(item.text));
    if (dimension !== "") {
      omitted.push({
        kind: item.kind,
        id: item.id,
        reason: REASON_BUDGET_PREFIX + dimension,
        provenance: item.provenance,
      });
      continue;
    }
    bundle.add(item);
  }
  return {
    project_id: input.state.project_id,
    rev: input.state.rev,
    items: bundle.items,
    omitted,
    chars: bundle.chars,
    estimated_tokens: estimateTokens(bundle.chars),
    basis: CONTEXT_BASIS,
    budget: echoBudget(input.budget),
  };
}

function echoBudget(budget: ContextBudget): CompileContextResult["budget"] {
  return {
    ...(budget.max_items === 0 ? {} : { max_items: budget.max_items }),
    ...(budget.max_chars === 0 ? {} : { max_chars: budget.max_chars }),
    ...(budget.max_tokens === 0 ? {} : { max_tokens: budget.max_tokens }),
  };
}

function validate(input: CompileContextInput): void {
  if (trimSpace(input.state.project_id) === "") {
    throw new Error(`${ERROR_PREFIX}state.project_id is empty`);
  }
  if (trimSpace(input.work.text) === "") {
    throw new Error(`${ERROR_PREFIX}work.text is empty`);
  }
  const { max_items, max_chars, max_tokens } = input.budget;
  if (max_items < 0 || max_chars < 0 || max_tokens < 0) {
    throw new Error(
      `${ERROR_PREFIX}budget must not be negative: {MaxItems:${max_items} MaxChars:${max_chars} MaxTokens:${max_tokens}}`,
    );
  }
  if (max_items === 0 && max_chars === 0 && max_tokens === 0) {
    throw new Error(`${ERROR_PREFIX}budget must set max_items, max_chars, or max_tokens`);
  }
  input.evidence.forEach((evidence, index) => {
    if (trimSpace(evidence.source) === "" || trimSpace(evidence.ref) === "") {
      throw new Error(`${ERROR_PREFIX}evidence ${evidenceId(index, evidence)} needs source and ref`);
    }
    if (evidence.relevance < 0 || !Number.isFinite(evidence.relevance)) {
      throw new Error(
        `${ERROR_PREFIX}evidence ${evidenceId(index, evidence)} has invalid relevance ${evidence.relevance}`,
      );
    }
  });
  const known = new Set(input.state.obligations.map((obligation) => obligation.id));
  for (const id of input.work.obligation_ids) {
    if (!known.has(id)) {
      throw new Error(`${ERROR_PREFIX}work.obligation_ids names unknown obligation ${JSON.stringify(id)}`);
    }
  }
}
