import type { HostMachine } from "./host_machine.js";
import type { ChangelogPorts } from "./changelog/ports.js";
import type { GatherPorts } from "./facts.js";
import type { Command, ConfigFiles, Process, ProcessResult } from "./ports.js";
import { Ripgrep } from "./tree.js";
import { NPMPeers } from "./units.js";

// The machine-backed adapters: every outside read gather performs that is a machine-local read (the rg tree,
// the working copy's build configuration, npm's peer edges), wired to the one HostMachine the CLI hands a
// gatherer. Nothing here calls a process, the filesystem or the network directly — every effect goes
// through the machine.
//
// The changelog and advisory sources (registry, releases, advisories) are NOT machine reads in this replica:
// the model-driven sources step owns them, so this composition refuses to supply their ports rather than
// read gh, npm and curl through the machine and claim a changelog nothing assembled.

const WHICH_BIN = "which";

/** Process over HostMachine.run: rg and npm run through it. */
export class MachineProcess implements Process {
  constructor(private readonly machine: HostMachine) {}

  /**
   * Runs the command in the machine's working directory. HostMachine.run takes no working directory, so a
   * caller asking for another one cannot be honoured; that is named rather than silently ignored.
   */
  async run(command: Command): Promise<ProcessResult> {
    if (command.dir !== undefined && command.dir !== this.machine.workingDirectory) {
      throw new Error(
        `depupgrade: run ${command.command} in ${command.dir}: HostMachine runs commands only in the CLI's working directory (${this.machine.workingDirectory})`,
      );
    }
    return await this.machine.run(command.command, command.args);
  }

  /** lookPath resolves through `which`, so a binary that is absent fails the way a shell reports it. */
  async lookPath(file: string): Promise<string> {
    const result = await this.machine.run(WHICH_BIN, [file]);
    if (result.code !== 0 || result.stdout.trim() === "") {
      throw new Error(`depupgrade: ${file} is not on PATH`);
    }
    return result.stdout.trim();
  }
}

/** ConfigFiles over HostMachine.readTextFile: a path the machine cannot read is a throw, as the port requires. */
export class MachineConfigFiles implements ConfigFiles {
  constructor(private readonly machine: HostMachine) {}

  async readFile(path: string): Promise<string> {
    const text = await this.machine.readTextFile(path);
    if (text === undefined) throw new Error(`depupgrade: cannot read ${path}`);
    return text;
  }
}

/** The step that owns the changelog and advisory sources in this replica. */
const SOURCES_STEP = "the model-driven sources step";

/** The failure reading the changelog ports must produce: no machine read can answer for a model step's sources. */
function modelOwnedSourcesError(): Error {
  return new Error(`changelog: the changelog and advisory sources are not machine reads — ${SOURCES_STEP} owns them`);
}

/**
 * Every outside read one gather performs, wired to `machine` over the working copy at `root`. The gatherer
 * calls this; facts.ts itself never touches the machine.
 *
 * Reading `changelog` throws. The changelog and advisory sources belong to the model-driven sources step, so
 * this composition supplies no ports for them; facts.ts catches the failure around Assemble and records it
 * in the gathered Facts — the gap agentmux records for a source it could not read — so a gather never
 * reports a silent empty changelog.
 */
export function gatherPorts(machine: HostMachine, root: string): GatherPorts {
  const process = new MachineProcess(machine);
  return {
    tree: new Ripgrep(process),
    config: new MachineConfigFiles(machine),
    peers: new NPMPeers(process),
    get changelog(): ChangelogPorts {
      throw modelOwnedSourcesError();
    },
    root,
  };
}
