/**
 * `omp config validate`: a preflight for "will omp start with this config?" that makes no
 * network or model call and starts no session.
 *
 * Settings come from the startup loader ({@link Settings.loadReadOnly}: global `config.yml`,
 * project settings, `--config` overlays) and are then checked layer by layer against the settings
 * registry. Extensions and custom tools go through the same discovery + import + factory-bind
 * functions a session uses, whose per-module `{ path, error }` results never abort startup and
 * are otherwise only logged.
 */

import { getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs";
import * as path from "node:path";
import "../config/all-settings";
import { all, type AnySetting, lookup } from "../config/registry";
import { Settings } from "../config/settings";
import { discoverCustomToolPaths, loadCustomTools } from "../extensibility/custom-tools";
import { loadSessionExtensions } from "../sdk";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "../tools";
import { EventBus } from "../utils/event-bus";

export type ConfigIssueSource = "settings" | "extension" | "custom-tool" | "discovery";

export interface ConfigIssue {
  source: ConfigIssueSource;
  /** File (or directory) the problem is in, when one is known. */
  file?: string;
  /** Dotted setting path, for a settings problem. */
  key?: string;
  /** What is wrong, without the file or key prefixes. */
  message: string;
}

export interface ConfigValidationReport {
  /** True when there is no error. Warnings never fail validation. */
  ok: boolean;
  agentDir: string;
  cwd: string;
  /** Problems that make startup fail, or a module/value that startup silently drops. */
  errors: ConfigIssue[];
  /** Problems startup tolerates (e.g. a key no setting owns, which an extension may read). */
  warnings: ConfigIssue[];
  settings: { files: string[] };
  extensions: { loaded: string[]; failed: string[] };
  customTools: { loaded: string[]; failed: string[] };
}

export interface ValidateConfigOptions {
  cwd: string;
  /** `--config` overlays, resolved against `cwd`. */
  configFiles?: string[];
  /** `-e/--extension` paths, as at startup. */
  extensionPaths?: string[];
  /** `--no-extensions`: only `extensionPaths` load. */
  noExtensions?: boolean;
}

type LayerKind = "global" | "project" | "overlay";

/** Every dotted prefix of a registered setting id: the keys that are settings groups, not settings. */
function registeredGroupPrefixes(): Set<string> {
  const groups = new Set<string>();
  for (const setting of all()) {
    const segments = setting.segments;
    for (let end = 1; end < segments.length; end++) groups.add(segments.slice(0, end).join("."));
  }
  return groups;
}

function causeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error: /, "");
}

/**
 * The reason `setting` rejects `value`, or `undefined` when it fits. A credential's value never
 * appears in the reason: the definition's own messages quote the value.
 */
function rejection(setting: AnySetting, value: unknown): string | undefined {
  // Path-scoped arrays hold `{ path, values }` entries that only resolve against a cwd.
  if (setting.definition.pathScoped && Array.isArray(value)) return undefined;
  try {
    setting.assertWritable(value);
    return undefined;
  } catch (error) {
    return setting.isCredential
      ? "value does not fit the setting's type (credential value not shown)"
      : causeOf(error);
  }
}

/** Checks one raw settings layer against the registry: invalid values are errors, unowned keys warnings. */
function checkLayer(
  layer: Record<string, unknown>,
  file: string,
  kind: LayerKind,
  groups: ReadonlySet<string>,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const id = prefix ? `${prefix}.${key}` : key;
      const setting = lookup(id);
      if (setting) {
        // `null` is the layer's way of unsetting a value.
        if (value === null || value === undefined) continue;
        const reason = rejection(setting, value);
        if (reason !== undefined) errors.push({ source: "settings", file, key: id, message: reason });
        continue;
      }
      if (isRecord(value) && groups.has(id)) {
        walk(value, id);
        continue;
      }
      // The project layer merges other tools' settings files (`.claude/settings.json`), so only
      // the files omp owns can be held to its key set.
      if (kind === "project") continue;
      warnings.push({
        source: "settings",
        file,
        key: id,
        message: "unknown setting: no setting owns this key, so omp ignores it (an extension may still read it)",
      });
    }
  };
  walk(layer, "");
}

async function validateSettings(
  options: ValidateConfigOptions,
  report: ConfigValidationReport,
): Promise<Settings | undefined> {
  const groups = registeredGroupPrefixes();
  let settings: Settings;
  try {
    settings = await Settings.loadReadOnly({ cwd: options.cwd, configFiles: options.configFiles });
  } catch (error) {
    // The loader names the file in its message ("Settings config is invalid: <path>: …").
    report.errors.push({ source: "settings", message: causeOf(error) });
    return undefined;
  }

  const globalPath = settings.getGlobalConfigPath();
  if (globalPath) {
    if (fs.existsSync(globalPath)) report.settings.files.push(globalPath);
    checkLayer(settings.getGlobalSettings(), globalPath, "global", groups, report.errors, report.warnings);
  }
  const projectFiles = settings.getProjectSourcePaths();
  report.settings.files.push(...projectFiles);
  checkLayer(
    settings.getProjectSettings(),
    projectFiles.length > 0 ? projectFiles.join(", ") : path.join(options.cwd, ".omp"),
    "project",
    groups,
    report.errors,
    report.warnings,
  );
  try {
    for (const overlay of await settings.readConfigOverlayFiles()) {
      report.settings.files.push(overlay.file);
      checkLayer(overlay.settings, overlay.file, "overlay", groups, report.errors, report.warnings);
    }
  } catch (error) {
    report.errors.push({ source: "settings", message: causeOf(error) });
  }
  return settings;
}

async function validateExtensions(
  options: ValidateConfigOptions,
  settings: Settings,
  report: ConfigValidationReport,
): Promise<void> {
  try {
    const result = await loadSessionExtensions(
      { additionalExtensionPaths: options.extensionPaths, disableExtensionDiscovery: options.noExtensions },
      options.cwd,
      settings,
      new EventBus(),
    );
    report.extensions.loaded = result.extensions.map(extension => extension.path);
    for (const { path: file, error } of result.errors) {
      report.extensions.failed.push(file);
      report.errors.push({ source: "extension", file, message: error });
    }
  } catch (error) {
    // Discovery itself (scanning extension directories, plugin manifests) failed before any import.
    report.errors.push({ source: "discovery", message: `extension discovery failed: ${causeOf(error)}` });
  }
}

async function validateCustomTools(options: ValidateConfigOptions, report: ConfigValidationReport): Promise<void> {
  try {
    const paths = await discoverCustomToolPaths([], options.cwd, getAgentDir());
    // A launch hands the loader the names of the built-ins its session created, which depend on
    // settings this check does not build a session for. Built-in name clashes are therefore
    // reported below as warnings; the loader still rejects clashes between custom tools.
    const result = await loadCustomTools(paths, options.cwd, [], () => {});
    report.customTools.loaded = result.tools.map(loaded => loaded.resolvedPath);
    for (const { path: file, error } of result.errors) {
      report.customTools.failed.push(file);
      report.errors.push({ source: "custom-tool", file, message: error });
    }
    const builtInNames = new Set([...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)]);
    for (const { tool, resolvedPath } of result.tools) {
      if (!builtInNames.has(tool.name)) continue;
      report.warnings.push({
        source: "custom-tool",
        file: resolvedPath,
        message:
          `tool "${tool.name}" has the name of a built-in tool; a launch drops it whenever that built-in is enabled`,
      });
    }
  } catch (error) {
    report.errors.push({ source: "discovery", message: `custom tool discovery failed: ${causeOf(error)}` });
  }
}

/**
 * Validates the settings layers, extensions and custom tools a launch from `options.cwd` would
 * load. Never throws for a config problem: each one is an entry of the returned report.
 */
export async function validateConfig(options: ValidateConfigOptions): Promise<ConfigValidationReport> {
  const report: ConfigValidationReport = {
    ok: true,
    agentDir: getAgentDir(),
    cwd: options.cwd,
    errors: [],
    warnings: [],
    settings: { files: [] },
    extensions: { loaded: [], failed: [] },
    customTools: { loaded: [], failed: [] },
  };

  let settings = await validateSettings(options, report);
  if (!settings) {
    // Settings that fail to load still leave the extension directories to check; the
    // `extensions:` / `disabledExtensions:` lists in the broken config are what go unevaluated.
    report.warnings.push({
      source: "settings",
      message: "extensions listed under `extensions:` in the settings that failed to load were not checked",
    });
    settings = Settings.isolated();
  }
  await validateExtensions(options, settings, report);
  await validateCustomTools(options, report);

  report.ok = report.errors.length === 0;
  return report;
}

function describeIssue(issue: ConfigIssue): string {
  const where = [issue.file, issue.key].filter(Boolean).join(" › ");
  return where ? `${where}: ${issue.message}` : issue.message;
}

/** Plain-text report: what was checked, then each problem with its file and cause. */
export function formatConfigValidationReport(report: ConfigValidationReport): string {
  const lines = [`Agent directory: ${report.agentDir}`, `Working directory: ${report.cwd}`, ""];
  lines.push(`Settings files read: ${report.settings.files.length}`);
  for (const file of report.settings.files) lines.push(`  ${file}`);
  lines.push(`Extensions: ${report.extensions.loaded.length} loaded, ${report.extensions.failed.length} failed`);
  for (const file of report.extensions.loaded) lines.push(`  ${file}`);
  lines.push(`Custom tools: ${report.customTools.loaded.length} loaded, ${report.customTools.failed.length} failed`);
  for (const file of report.customTools.loaded) lines.push(`  ${file}`);
  lines.push("");
  if (report.errors.length > 0) {
    lines.push(`Errors (${report.errors.length}):`);
    for (const issue of report.errors) lines.push(`  ✗ [${issue.source}] ${describeIssue(issue)}`);
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const issue of report.warnings) lines.push(`  ! [${issue.source}] ${describeIssue(issue)}`);
    lines.push("");
  }
  lines.push(report.ok ? "Config OK." : `Config invalid: ${report.errors.length} error(s).`);
  return `${lines.join("\n")}\n`;
}
