import { Command } from "commander";
import { isThinkingLevel } from "@nova/core";
import { loadSettings } from "@nova/runtime";
import { createContext } from "./context.js";
import { runRepl } from "./repl.js";
import { printSessionList } from "./session-view.js";
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
  listSessions?: boolean;
  think?: string;
}

async function run(positional: string[], opts: CliOptions): Promise<void> {
  const initialPrompt = opts.prompt ?? positional.join(" ").trim();

  let settings = await loadSettings();
  settings = await ensureSettings(settings);
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
      console.error(
        `invalid --think value: ${raw} (expected off|low|medium|high|max or a positive integer)`,
      );
      process.exit(2);
    }
  }

  if (opts.listSessions) {
    await printSessionList(settings.sessionDir);
    return;
  }

  if (!settings.apiKey) {
    console.error("apiKey is not set in nova.config.json (or equivalent settings file).");
    process.exit(2);
  }

  const ctx = await createContext(settings, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.continue !== undefined ? { continue: opts.continue } : {}),
    ...(opts.noTranscript !== undefined ? { noTranscript: opts.noTranscript } : {}),
    ...(opts.noPretty !== undefined ? { noPretty: opts.noPretty } : {}),
  });

  await runRepl(ctx, initialPrompt);
}

const program = new Command();
program
  .name("harness")
  .description("Loop-centric agent harness (M1 base)")
  .argument("[prompt...]", "optional initial prompt (REPL still starts after it runs)")
  .option("-p, --prompt <text>", "optional initial prompt (alternative to positional)")
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
  .option("--list-sessions", "list saved sessions and exit")
  .action((positional: string[], opts: CliOptions) => run(positional, opts));

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
