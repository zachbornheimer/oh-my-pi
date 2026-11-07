import type { FleetChild, FleetOutput } from "./fleet.js";

function childLine(child: FleetChild): string {
  const exit = child.exit_code === undefined ? "" : ` exit ${child.exit_code}`;
  const model = child.model ? ` model ${child.model}` : "";
  return `${child.name} [${child.id}] ${child.state}${exit} agent ${child.agent}${model} inbox ${child.inbox} output ${child.output_path}`;
}

/** The model-facing text of one op's result. */
export function renderOutput(output: FleetOutput): string {
  const head = `task_fleet ${output.op}, session ${output.session} (state ${output.state_dir})`;
  switch (output.op) {
    case "spawn":
      return [
        `${head}: started ${output.ids?.length ?? 0} child(ren); none has finished. Read output_path or call list for progress.`,
        ...(output.children ?? []).map(childLine),
      ].join("\n");
    case "list":
      return output.children?.length
        ? [`${head}:`, ...output.children.map(childLine)].join("\n")
        : `${head}: no children.`;
    case "send":
      return `${head}: delivered to ${output.delivered_to?.join(", ")}.`;
    case "kill":
      return output.killed?.length
        ? `${head}: killed ${output.killed.join(", ")}.`
        : `${head}: nothing killed; every target had already exited.`;
  }
}
