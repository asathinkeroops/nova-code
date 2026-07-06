import { Command } from "commander";
import { isThinkingLevel } from "@nova/core";
import { loadSettings, type Settings } from "@nova/runtime";
import { createContext } from "./context.js";
import { runHeadless, type HeadlessOutputFormat } from "./headless.js";
import { buildMcpCommand } from "./mcp-cli.js";
import { buildPluginCommand } from "./plugin-cli.js";
import type { HeadlessApprovalPolicy } from "./headless-screen.js";
import type { PermissionMode } from "./permissions.js";
import { runRepl } from "./repl.js";
import { Screen, fatalExit } from "./screen.js";
import { pruneOldSessions } from "./session.js";
import { ensureSettings } from "./setup.js";

interface CliOptions {
  prompt?: string;
  model?: string;
  maxTurns?: number;
  cwd?: string;
  noTranscript?: boolean;
  noPretty?: boolean;
  resume?: string;
  continue?: boolean;
  think?: string;
  outputFormat?: string;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
}

/**
 * Apply `--model` / `--max-turns` / `--think` onto the loaded settings.
 * Throws on an invalid `--think` value so each entry path can surface it in its
 * own way (Ink fatalExit vs. plain stderr).
 */
function applyCliOverrides(settings: Settings, opts: CliOptions): void {
  if (opts.model) settings.model = opts.model;
  if (opts.maxTurns) settings.maxTurns = opts.maxTurns;
  if (opts.think) {
    const raw = opts.think.trim();
    const asNumber = Number.parseInt(raw, 10);
    if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === raw) {
      settings.thinking.budgetTokens = asNumber;
    } else if (isThinkingLevel(raw)) {
      settings.thinking.level = raw;
      settings.thinking.budgetTokens = undefined;
    } else {
      throw new Error(
        `invalid --think value: ${raw} (expected off|low|medium|high|max or a positive integer)`,
      );
    }
  }
}

/**
 * Validate `--permission-mode`, defaulting to `default`. Throws on an unknown
 * value so each entry path can surface it its own way (dieHeadless vs fatalExit).
 */
function parsePermissionMode(raw: string | undefined): PermissionMode {
  const mode = (raw ?? "default") as PermissionMode;
  if (!["default", "acceptEdits", "auto", "plan"].includes(mode)) {
    throw new Error(
      `invalid --permission-mode: ${raw} (expected default, acceptEdits, auto, or plan)`,
    );
  }
  return mode;
}

/** Read all of stdin to a string. Used to accept a piped prompt in headless mode. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function dieHeadless(message: string, code: number): never {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(code);
}

/**
 * Non-interactive single-turn run. Triggered by `-p`/`--prompt` or
 * automatically when stdin/stdout is not a TTY (pipes, redirects, CI, git
 * hooks). Runs the full agent loop once and exits with its result code — no
 * REPL, no Ink.
 */
async function runHeadlessMode(
  settings: Settings,
  positional: string[],
  opts: CliOptions,
): Promise<never> {
  let prompt = opts.prompt ?? positional.join(" ").trim();
  if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();
  if (!prompt) {
    dieHeadless(
      "headless mode requires a prompt (pass it as an argument, via -p, or on stdin).",
      2,
    );
  }

  try {
    applyCliOverrides(settings, opts);
  } catch (err) {
    dieHeadless(err instanceof Error ? err.message : String(err), 2);
  }

  if (!settings.apiKey) {
    dieHeadless("apiKey is not set in nova.config.json (or equivalent settings file).", 1);
  }

  const outputFormat = (opts.outputFormat ?? "text") as HeadlessOutputFormat;
  if (!["text", "json", "jsonl"].includes(outputFormat)) {
    dieHeadless(`invalid --output-format: ${opts.outputFormat} (expected text, json, or jsonl)`, 2);
  }

  let permissionMode: PermissionMode;
  try {
    permissionMode = parsePermissionMode(opts.permissionMode);
  } catch (err) {
    dieHeadless(err instanceof Error ? err.message : String(err), 2);
  }
  const approvalPolicy: HeadlessApprovalPolicy = opts.dangerouslySkipPermissions ? "allow" : "deny";

  let code: number;
  try {
    code = await runHeadless(settings, {
      prompt,
      outputFormat,
      permissionMode,
      approvalPolicy,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts.continue !== undefined ? { continue: opts.continue } : {}),
      ...(opts.noTranscript !== undefined ? { noTranscript: opts.noTranscript } : {}),
      ...(opts.noPretty !== undefined ? { noPretty: opts.noPretty } : {}),
    });
  } catch (err) {
    dieHeadless(err instanceof Error ? err.message : String(err), 1);
  }
  process.exit(code);
}

async function run(positional: string[], opts: CliOptions): Promise<void> {
  let settings = await loadSettings();

  // `-p`/`--prompt` is the headless trigger (run once, print, exit); a non-TTY
  // environment also forces headless even without it. The bare positional
  // prompt stays interactive: it seeds the first turn, then the REPL takes over.
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (opts.prompt !== undefined || !isTTY) {
    await runHeadlessMode(settings, positional, opts);
  }

  const initialPrompt = positional.join(" ").trim();
  const screen = new Screen({
    syncOutput: settings.terminal.syncOutput,
    cursorFollow: settings.terminal.cursorFollow,
  });
  screen.mount();

  try {
    settings = await ensureSettings(settings, screen);
    try {
      applyCliOverrides(settings, opts);
      // Seed the input-box permission mode from --permission-mode (still
      // shift+tab-cycleable afterwards), and arm the auto-approve bypass from
      // --dangerously-skip-permissions so it works in the REPL, not just -p.
      screen.setPermissionMode(parsePermissionMode(opts.permissionMode));
      if (opts.dangerouslySkipPermissions) screen.enableBypass();
    } catch (err) {
      await fatalExit(screen, err instanceof Error ? err.message : String(err));
    }

    if (!settings.apiKey) {
      await fatalExit(
        screen,
        "apiKey is not set in nova.config.json (or equivalent settings file).",
      );
    }

    const ctx = await createContext(settings, screen, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      ...(opts.continue !== undefined ? { continue: opts.continue } : {}),
      ...(opts.noTranscript !== undefined ? { noTranscript: opts.noTranscript } : {}),
      ...(opts.noPretty !== undefined ? { noPretty: opts.noPretty } : {}),
    });

    await pruneOldSessions(ctx);

    await runRepl(ctx, initialPrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fatalExit(screen, msg, 1);
  }
}

const program = new Command();
program
  .name("nova")
  .description("A terminal coding agent, deeply tuned for DeepSeek.")
  .argument("[prompt...]", "optional initial prompt (REPL still starts after it runs)")
  .option("-p, --prompt <text>", "run a single turn headless (print the answer and exit)")
  .option("-m, --model <name>", "override model id")
  .option(
    "-t, --think <level>",
    "extended thinking level (off|low|medium|high|max or a positive integer budget)",
  )
  .option("--max-turns <n>", "override maxTurns", (v) => Number.parseInt(v, 10))
  .option("--cwd <dir>", "override working directory for tools")
  .option("--no-transcript", "skip writing to the session transcript")
  .option("--no-pretty", "disable pretty logging")
  .option("-c, --continue", "resume the most recent session")
  .option("--resume <id>", "resume a session by id")
  .option(
    "--output-format <fmt>",
    "headless output: text (default) | json (outcome + full messages) | jsonl (streamed events)",
  )
  .option(
    "--permission-mode <mode>",
    "initial permission mode: default | acceptEdits | auto | plan",
  )
  .option(
    "--dangerously-skip-permissions",
    "auto-approve every permission prompt (unattended writes)",
  )
  .action((positional: string[], opts: CliOptions) => run(positional, opts));

program.addCommand(buildMcpCommand());
program.addCommand(buildPluginCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
