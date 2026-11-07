import type { ConfigValidationReport } from "@oh-my-pi/pi-coding-agent/cli/config-validate";
import { TempDir } from "@oh-my-pi/pi-utils";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

// Each case boots the real CLI in a child process, which imports the whole SDK.
setDefaultTimeout(120_000);

let home: TempDir;
let agentDir: string;
let projectDir: string;

interface CliResult {
  exitCode: number;
  output: string;
  error: string;
}

/** Runs the real CLI against the temp agent dir, so the exit code is the one a script would see. */
async function runValidate(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, cliEntry, "config", "validate", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", HOME: home.path(), PI_CODING_AGENT_DIR: agentDir },
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
  return { exitCode, output, error };
}

function writeAgentFile(relative: string, content: string): string {
  const file = path.join(agentDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  home = TempDir.createSync("@omp-config-validate-");
  agentDir = path.join(home.path(), "agent");
  projectDir = path.join(home.path(), "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(async () => {
  await home.remove();
});

describe("omp config validate", () => {
  it("exits 0 for a clean config and a working extension", async () => {
    writeAgentFile("config.yml", "compaction:\n  enabled: false\n");
    const extension = writeAgentFile("extensions/good.ts", "export default function good(_pi: unknown) {}\n");

    const result = await runValidate();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Config OK.");
    expect(result.output).toContain("1 loaded, 0 failed");
    expect(result.output).toContain(extension);
  });

  it("reports a syntactically broken extension by path and exits non-zero", async () => {
    const broken = writeAgentFile("extensions/broken.ts", "export default function broken( {\n");

    const result = await runValidate();

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("[extension]");
    expect(result.output).toContain(broken);
    expect(result.output).toContain("Config invalid: 1 error(s).");
  });

  it("reports an extension whose factory throws", async () => {
    const throwing = writeAgentFile(
      "extensions/throws.ts",
      "export default function throws(_pi: unknown) { throw new Error(\"boom from factory\"); }\n",
    );

    const result = await runValidate();

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(throwing);
    expect(result.output).toContain("boom from factory");
  });

  it("reports an invalid setting value with its file and key", async () => {
    const configFile = writeAgentFile("config.yml", "compaction:\n  enabled: \"maybe\"\n");

    const result = await runValidate();

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("[settings]");
    expect(result.output).toContain(configFile);
    expect(result.output).toContain("compaction.enabled");
    expect(result.output).toContain("Config invalid");
  });

  it("reports a project layer value and a --config overlay value that do not fit their setting", async () => {
    const overlay = path.join(home.path(), "overlay.yml");
    fs.writeFileSync(overlay, "compaction:\n  enabled: 7\n");

    const result = await runValidate("--config", overlay, "--json");
    const report = JSON.parse(result.output) as ConfigValidationReport;

    expect(result.exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ source: "settings", file: overlay, key: "compaction.enabled" }),
    );
  });

  it("warns about a key no setting owns without failing", async () => {
    const configFile = writeAgentFile("config.yml", "definitelyNotASetting: true\n");

    const result = await runValidate("--json");
    const report = JSON.parse(result.output) as ConfigValidationReport;

    expect(result.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ source: "settings", file: configFile, key: "definitelyNotASetting" }),
    );
  });

  it("reports a --config overlay that does not exist", async () => {
    const missing = path.join(home.path(), "missing.yml");

    const result = await runValidate("--config", missing);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(missing);
  });

  it("honors --no-extensions: a broken discovered extension is not loaded, an explicit -e one still is", async () => {
    writeAgentFile("extensions/broken.ts", "export default function broken( {\n");
    const explicit = path.join(home.path(), "explicit-broken.ts");
    fs.writeFileSync(explicit, "this is not typescript (\n");

    const skipped = await runValidate("--no-extensions");
    expect(skipped.exitCode).toBe(0);

    const explicitOnly = await runValidate("--no-extensions", "-e", explicit);
    expect(explicitOnly.exitCode).toBe(1);
    expect(explicitOnly.output).toContain(explicit);
    expect(explicitOnly.output).not.toContain("extensions/broken.ts");
  });

  it("reports a broken custom tool by path", async () => {
    const tool = writeAgentFile("tools/broken-tool/index.ts", "export default ( {\n");

    const result = await runValidate();

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("[custom-tool]");
    expect(result.output).toContain(tool);
  });
});
