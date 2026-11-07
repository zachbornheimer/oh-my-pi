import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { type Exec, type ModelStep, ompModelStep } from "./omp_model.ts";
import { type SiteContext, siteContextNamed } from "./site_context.ts";
import type { StageEnv } from "./stage_types.ts";
import { progressTo, type Update } from "./tool_common.ts";

export type Pi = Parameters<CustomToolFactory>[0];

/** The site a call names (`site`): its site file's context, or undefined when the call names none. Throws when the file is missing. */
export async function siteOf(name: string | null | undefined, directory?: string): Promise<SiteContext | undefined> {
  if (name === undefined || name === null || name.trim() === "") return undefined;
  return siteContextNamed(name.trim(), directory);
}

/** The model step: the test's own when given, else one `omp -p` child process through `pi.exec`. */
export function modelStepOf(pi: Pi, step: ModelStep | undefined): ModelStep {
  return step ?? ompModelStep(((command, args, options) => pi.exec(command, args, options)) as Exec);
}

/** The environment a stage runs in for one call. */
export function stageEnv(pi: Pi, step: ModelStep | undefined, onUpdate: Update, signal?: AbortSignal): StageEnv {
  return {
    z: pi.zod,
    step: modelStepOf(pi, step),
    progress: progressTo(onUpdate),
    ...(signal === undefined ? {} : { signal }),
  };
}
