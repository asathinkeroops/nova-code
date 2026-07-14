import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { isProviderId, PROVIDER_IDS } from "@nova/core";
import {
  DEFAULT_CONFIG_PATH,
  loadProjectHooks,
  parseSettings,
  REQUIRED_MODEL_TIERS,
  resolveLanguage,
  type Settings,
} from "@nova/runtime";
import { bold, dim, green, red, yellow } from "./colors.js";

/**
 * Config check ("doctor"). Validates the global `~/.nova/nova.config.json` plus
 * the workspace's project hook files, and summarizes MCP setup. It never throws
 * and never blocks — the caller decides how to surface {@link ConfigReport} and
 * falls back to `settings` (the parsed config when valid, all-defaults when not).
 *
 * Layering: this is a pure *file*-level check, so it can run before any session
 * exists (startup auto-check, `nova doctor`). Live-session facts like context
 * usage are added by the `/doctor` slash handler, which has a `CliContext`.
 */

export type IssueLevel = "error" | "warn";

export interface ConfigIssue {
  level: IssueLevel;
  /** One-line headline, e.g. `invalid setting: model`. */
  title: string;
  /** Optional supporting detail (a parser message, the offending value, …). */
  detail?: string;
  /** Optional actionable next step. */
  hint?: string;
}

export interface ConfigReport {
  configPath: string;
  /** Whether the config file exists on disk (a missing file is normal, not an error). */
  exists: boolean;
  /**
   * `true` when the global config parsed as JSON *and* satisfied the settings
   * schema, i.e. it is usable exactly as written. `false` means the returned
   * settings were replaced with defaults so the app can still continue. Project
   * hook / MCP findings do NOT affect this — they are non-fatal (see below).
   */
  valid: boolean;
  /** Problems to surface: `error` (blocks) or `warn` (non-blocking). */
  issues: ConfigIssue[];
  /** Informational lines (MCP summary, hooks loaded, …). Shown only by explicit
   *  `nova doctor` / `/doctor`, never by the quiet startup auto-check. */
  info: string[];
}

export interface DiagnoseOptions {
  /** Global config file to read (defaults to {@link DEFAULT_CONFIG_PATH}). */
  configPath?: string;
  /** Workspace root; when set, project hook files under it are validated too. */
  workspace?: string;
}

interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

/** Pull zod's `.issues` off a caught error without importing zod here. */
function zodIssues(err: unknown): ZodLikeIssue[] {
  if (err && typeof err === "object" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as { issues: ZodLikeIssue[] }).issues;
  }
  return [];
}

/** A guaranteed-valid, all-defaults Settings, with `language` resolved like loadSettings does. */
function defaultSettings(): Settings {
  const settings = parseSettings({});
  settings.language = resolveLanguage(settings);
  return settings;
}

/** Info lines summarizing the (already schema-validated) MCP setup. */
function mcpSummary(settings: Settings): string[] {
  const mcp = settings.mcp;
  if (!mcp.enabled) return ["MCP: disabled (mcp.enabled = false)"];
  const servers = Object.values(mcp.servers);
  if (servers.length === 0) return ["MCP: no servers configured"];
  let stdio = 0;
  let http = 0;
  let disabled = 0;
  for (const s of servers) {
    if (s.type === "http" || s.type === "sse") http += 1;
    else stdio += 1;
    if (s.enabled === false) disabled += 1;
  }
  const kinds = [stdio > 0 ? `${stdio} stdio` : "", http > 0 ? `${http} http` : ""]
    .filter(Boolean)
    .join(", ");
  let line = `MCP: ${servers.length} server(s) configured${kinds ? ` (${kinds})` : ""}`;
  if (disabled > 0) line += ` · ${disabled} disabled`;
  return [line];
}

/**
 * Read and check the config without throwing. Returns the diagnostic report plus
 * a usable Settings: the parsed config when the global file is valid, otherwise
 * all-defaults so boot can proceed.
 */
export async function diagnoseConfig(
  opts: DiagnoseOptions = {},
): Promise<{ report: ConfigReport; settings: Settings }> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const issues: ConfigIssue[] = [];
  const info: string[] = [];
  let settings: Settings | undefined;
  let exists = true;

  // --- Global config file: JSON + schema (schema also covers model/tier
  //     completeness and mcp.servers validity). ---
  let text: string | undefined;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      exists = false; // fresh-install state — not a problem to report.
    } else {
      issues.push({
        level: "error",
        title: "config file could not be read",
        detail: err instanceof Error ? err.message : String(err),
        hint: `check permissions on ${configPath}`,
      });
    }
  }

  if (text !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      issues.push({
        level: "error",
        title: "config is not valid JSON",
        detail: err instanceof Error ? err.message : String(err),
        hint: `fix the syntax in ${configPath}`,
      });
    }
    if (raw !== undefined) {
      try {
        settings = parseSettings(raw);
        settings.language = resolveLanguage(settings);
      } catch (err) {
        const zi = zodIssues(err);
        if (zi.length > 0) {
          for (const issue of zi) {
            issues.push({
              level: "error",
              title: `invalid setting: ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}`,
              detail: issue.message,
            });
          }
        } else {
          issues.push({
            level: "error",
            title: "config failed validation",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // Completeness warnings the schema deliberately does NOT enforce (an
  // empty/keyless config is the valid pre-setup state) but which mean the config
  // can't actually drive the agent as written.
  if (settings) {
    const hasApiKey = typeof settings.apiKey === "string" && settings.apiKey.trim().length > 0;
    if (!hasApiKey) {
      issues.push({
        level: "warn",
        title: "no apiKey configured",
        hint: 'nova will run first-time setup, or add "apiKey" to your config',
      });
    }
    if (hasApiKey && Object.keys(settings.models).length === 0) {
      issues.push({
        level: "warn",
        title: "apiKey is set but no models are configured",
        hint: `add a "models" table with all tiers (${REQUIRED_MODEL_TIERS.join(", ")})`,
      });
    }
    // `provider` is a free-form string (the schema can't enumerate core's
    // profile registry across the package boundary), so an id that isn't a
    // built-in silently resolves to the generic `other` profile. That's a valid
    // choice for a plain Anthropic-compatible endpoint, but usually it's a typo
    // — flag it so the user isn't surprised by the missing effort knob / error
    // translation / balance readout.
    if (!isProviderId(settings.provider)) {
      issues.push({
        level: "warn",
        title: `provider "${settings.provider}" is not a built-in profile`,
        detail: `using the generic "other" fallback (no effort knob, error translation, or balance)`,
        hint: `set "provider" to one of: ${PROVIDER_IDS.join(", ")} — or keep it if this endpoint is a plain Anthropic-compatible one`,
      });
    }
  }

  // --- Project hook files (`.nova/hooks.json`, `.nova/hooks.local.json`).
  //     Independent of the global config, and NON-fatal: a bad file is skipped
  //     at load (loadProjectHooks collects, never throws), so it's a warning
  //     that must not flip `valid`/block startup. ---
  if (opts.workspace) {
    const hooks = await loadProjectHooks(opts.workspace);
    for (const e of hooks.errors) {
      issues.push({
        level: "warn",
        title: `invalid hook file: ${basename(e.source)}`,
        detail: e.message,
        hint: "fix or remove it — nova skips it and continues",
      });
    }
    if (hooks.loaded.length > 0) {
      info.push(`project hooks: loaded ${hooks.loaded.length} file(s)`);
    }
  }

  // --- MCP summary (informational; global mcp.servers is already schema-checked
  //     above, so this is a readout, not a re-validation). ---
  if (settings) info.push(...mcpSummary(settings));

  const valid = !exists || settings !== undefined;
  return {
    report: { configPath, exists, valid, issues, info },
    settings: settings ?? defaultSettings(),
  };
}

const errorCount = (r: ConfigReport): number => r.issues.filter((i) => i.level === "error").length;
const warnCount = (r: ConfigReport): number => r.issues.filter((i) => i.level === "warn").length;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One-line summary for a card/modal title / log prefix, e.g. `1 error, 2 warnings`. */
export function summarizeReport(report: ConfigReport): string {
  return `${plural(errorCount(report), "error")}, ${plural(warnCount(report), "warning")}`;
}

/** Render the issue list as indented lines (used by the modal, doctor, and stderr). */
export function formatIssues(report: ConfigReport): string {
  return report.issues
    .map((issue) => {
      const mark = issue.level === "error" ? red("✗") : yellow("⚠");
      const lines = [`${mark} ${issue.title}`];
      if (issue.detail) lines.push(`  ${dim(issue.detail)}`);
      if (issue.hint) lines.push(`  ${dim(`↳ ${issue.hint}`)}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Full `nova doctor` report: health line, issues, then any info lines. */
export function formatDoctorReport(report: ConfigReport): string {
  const blocks = [`${bold("config check")}  ${dim(report.configPath)}`];
  if (!report.exists) {
    blocks.push(dim("no config file yet — nova will run first-time setup on launch."));
  } else if (report.issues.length === 0) {
    blocks.push(green("✓ config looks good"));
  } else {
    blocks.push(formatIssues(report));
    blocks.push(dim(summarizeReport(report)));
  }
  if (report.info.length > 0) {
    blocks.push(report.info.map((l) => dim(`· ${l}`)).join("\n"));
  }
  return blocks.join("\n");
}

/**
 * Terminal message for a config that failed JSON/schema validation. Unlike the
 * soft-warning path, an invalid config can't be run on: continuing would mean
 * silently ignoring everything the user configured (and misreporting downstream,
 * e.g. "apiKey is not set" when the real fault is elsewhere). So we state the
 * real errors and point at the fix.
 */
export function formatInvalidConfigError(report: ConfigReport): string {
  return [
    `${bold(red("your nova config has errors and can't be used as written:"))}`,
    "",
    formatIssues(report),
    "",
    dim(`fix ${report.configPath} (or run \`nova doctor\`) and re-launch.`),
  ].join("\n");
}

/**
 * A prompt handed to the agent when the user presses `f` in the `/doctor` modal:
 * lists the reported problems and asks it to fix the config file in place.
 */
export function buildFixPrompt(report: ConfigReport): string {
  const lines = report.issues.map(
    (i) => `- ${i.title}${i.detail ? `: ${i.detail}` : ""}`,
  );
  return [
    `My nova config (${report.configPath}) has the following problems reported by \`/doctor\`:`,
    "",
    ...lines,
    "",
    "Please fix the config file so these are resolved. Read it first, make the " +
      "minimal edits, preserve everything else (especially my apiKey), and keep it " +
      "valid against the settings schema. Don't launch the app — just fix the file.",
  ].join("\n");
}

/**
 * `nova doctor` — run the config check (including project hooks in the current
 * working directory), print the full report, and exit non-zero only when there
 * are hard errors (warnings alone still exit 0).
 */
export function buildDoctorCommand(): Command {
  return new Command("doctor")
    .description("check the global nova config for problems")
    .option("--config <path>", "path to the config file to check", DEFAULT_CONFIG_PATH)
    .action(async (opts: { config: string }) => {
      const { report } = await diagnoseConfig({
        configPath: opts.config,
        workspace: process.cwd(),
      });
      process.stdout.write(`${formatDoctorReport(report)}\n`);
      process.exit(errorCount(report) > 0 ? 1 : 0);
    });
}
