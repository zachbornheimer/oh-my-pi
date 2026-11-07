import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

/** omp's own `pi.zod` (omptype): the validator for model replies and the builder of tool parameters. */
export type Zod = Parameters<CustomToolFactory>[0]["zod"];
