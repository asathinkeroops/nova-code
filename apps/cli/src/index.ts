import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadMemory, type MemoryBundle } from "@nova/context";
import {
  agentLoop,
  blocksOf,
  createAnthropicModel,
  extractText,
  isThinkingLevel,
  resolveBudget,
  THINKING_BUDGETS,
  THINKING_LEVELS,
  userText,
  type LoopObserver,
  type MessageParam,
  type ModelClient,
  type ThinkingLevel,
} from "@nova/core";
import { Transcript } from "@nova/observability";
import {
  createLogger,
  createSession,
  getSession,
  listSessions,
  loadSettings,
  saveSettings,
  type Logger,
  type Session,
} from "@nova/runtime";
import { makeTodoReminder, TodoStore, type Todo } from "@nova/orchestration";
import { PermissionDeniedError, PermissionEngine, promptApproval } from "@nova/safety";
import { ToolRegistry, builtinTools, createDispatcher } from "@nova/tools";
import { renderBanner } from "./banner.js";
import { Screen, type Spinner } from "./screen.js";
import {
  bold,
  CYAN_RGB,
  cyan,
  dim,
  green,
  MAGENTA_RGB,
  magenta,
  red,
  strike,
} from "./colors.js";
import { askUser } from "./ask.js";
import { readBoxedLine, type SlashCommand } from "./input.js";
import { renderMarkdown } from "./markdown.js";
import {
  renderRedactedThinking,
  renderThinking,
  renderToolResult,
  renderToolUse,
} from "./renderers.js";
import { buildCompactor, manualCompact } from "./compactor.js";
import { predictNextInput } from "./predict.js";
import { pickHorizontal, pickOne, pickerArrow } from "./picker.js";
import { emptyCursor, loadMessages, persistMessages, type PersistCursor } from "./persistence.js";
import { ensureSettings } from "./setup.js";

async function readCliVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "../package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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

async function resolveSession(
  opts: CliOptions,
  sessionDir: string | undefined,
): Promise<{ session: Session; resumed: boolean }> {
  if (opts.resume) {
    const found = await getSession(opts.resume, sessionDir);
    if (!found) {
      console.error(`session ${opts.resume} not found`);
      process.exit(2);
    }
    return { session: found, resumed: true };
  }
  if (opts.continue) {
    const list = await listSessions(sessionDir);
    if (list.length === 0) {
      console.error("no sessions to continue");
      process.exit(2);
    }
    return { session: list[0]!, resumed: true };
  }
  return { session: await createSession(sessionDir), resumed: false };
}

async function printSessionList(sessionDir: string | undefined): Promise<void> {
  const list = await listSessions(sessionDir);
  type Row = { id: string; createdAt: Date; label: string };
  const rows: Row[] = [];
  for (const s of list) {
    try {
      const msgs = await loadMessages(s.messagesPath);
      if (msgs.length === 0) continue;
      rows.push({ id: s.id, createdAt: s.createdAt, label: firstUserLabel(msgs) });
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      rows.push({
        id: s.id,
        createdAt: s.createdAt,
        label: red(`load failed: ${msg.slice(0, 80)}`),
      });
    }
  }
  if (rows.length === 0) {
    process.stdout.write("no sessions found\n");
    return;
  }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${dim(formatTimestamp(r.createdAt))}  ${dim(r.label)}\n`);
  }
}

function formatTimestamp(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function firstUserLabel(msgs: MessageParam[]): string {
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const text = extractText(blocksOf(m)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
  return "(no user message)";
}

function buildSystemPrompt(workspace: string, memory: MemoryBundle, sessionId: string): string {
  const base = `You are a coding agent at ${workspace}. Use tools to solve tasks. Use todo tools for checklist, mark in_progress before starting, completed when done, error when failed. Act, don't explain.
<identity>
name: Nova
</identity>

<system-info>
platform: ${process.platform}
time: ${new Date().toISOString()}
</system-info>

<session>
id: ${sessionId}
</session>
`;
  if (!memory.system) return base;
  return `${base}\n${memory.system}\n`;
}

function renderTodoHeader(todos: Todo[]): string[] {
  if (todos.length === 0) return [];
  const item = (t: Todo): string => {
    switch (t.status) {
      case "completed":
        return `${green("■")} ${dim(strike(t.description))}`;
      case "in_progress":
        return `${cyan("■")} ${bold(t.description)}`;
      case "error":
        return `${red("■")} ${red(t.description)}`;
      case "pending":
      default:
        return `□ ${t.description}`;
    }
  };
  return todos.map((t, i) =>
    i === 0 ? `${dim("  ⎿  ")}${item(t)}` : `     ${item(t)}`,
  );
}

const WORKING_WORDS = [
  "Thinking...",
  "Pondering...",
  "Churning...",
  "Crunching...",
  "Cooking...",
  "Brewing...",
  "Hatching...",
  "Mulling...",
  "Computing...",
  "Reasoning...",
  "Synthesizing...",
  "Cogitating...",
  "Deliberating...",
  "Working...",
  "Hustling...",
  "Tinkering...",
  "Plotting...",
  "Scheming...",
];

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "show this help" },
  { name: "/model", description: "show or change the active model" },
  { name: "/think", description: "show or change the extended-thinking level" },
  { name: "/clear", description: "clear conversation history (keeps session)" },
  { name: "/compact", description: "summarize history into a single message" },
  { name: "/resume", description: "switch to a saved session" },
  { name: "/predict", description: "show or toggle next-input prediction" },
  { name: "/exit", description: "leave the REPL" },
  { name: "/quit", description: "leave the REPL" },
];

const HELP_TEXT = `Commands:
  /help              show this help
  /model [<name>]    show or change the active model
  /think [<level>]   show or change extended thinking (off|low|medium|high|max or a positive integer budget)
  /clear             clear conversation history (keeps session)
  /compact [focus…]  summarize history into a single message (optional focus hint)
  /resume [<id>]     switch to a saved session (no arg = pick from list)
  /predict [on|off]  show or toggle next-input prediction placeholder
  /exit, /quit       leave the REPL (Ctrl+D also works)`;

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

  const apiKey = settings.apiKey;
  if (!apiKey) {
    console.error("apiKey is not set in nova.config.json (or equivalent settings file).");
    process.exit(2);
  }

  const buildLogger = (destination: string): Logger =>
    createLogger({
      level: settings.logging.level,
      pretty: settings.logging.pretty && !opts.noPretty,
      destination,
    });

  let { session, resumed } = await resolveSession(opts, settings.sessionDir);
  let logPath = join(session.dir, "session.log");
  let logger = buildLogger(logPath);

  const workspace = opts.cwd ?? process.cwd();

  const memoryOpts: Parameters<typeof loadMemory>[1] = {
    filenames: settings.memory.filenames,
    ...(settings.memory.userPaths ? { userPaths: settings.memory.userPaths } : {}),
    ...(settings.memory.globalPath ? { globalPath: settings.memory.globalPath } : {}),
  };
  const memory = await loadMemory(workspace, memoryOpts);

  const version = await readCliVersion();
  const clearScreen = (): void => {
    process.stdout.write("\x1b[2J\x1b[H");
  };
  const printBanner = (): void => {
    process.stdout.write(
      `\n${renderBanner({ version, model: settings.model, cwd: workspace, home: homedir(), sessionId: session.id })}\n`,
    );
  };
  if (resumed) clearScreen();
  printBanner();
  logger.info(
    { sessionId: session.id, dir: session.dir, resumed },
    resumed ? "session resumed" : "session started",
  );
  if (memory.sources.length > 0) {
    logger.info({ sources: memory.sources }, "memory loaded");
  }

  let transcript = new Transcript(session.transcriptPath);
  await transcript.append({
    kind: "session_start",
    data: {
      id: session.id,
      cwd: workspace,
      model: settings.model,
      resumed,
    },
  });
  if (memory.sources.length > 0) {
    await transcript.append({ kind: "memory_loaded", data: { sources: memory.sources } });
  }

  // Cross-references between the per-turn ESC watcher and the persistent
  // permission ask callback. The permission engine is built once at startup,
  // but each runTurn creates its own AbortController + stdin watcher — this
  // shared box lets the ask callback observe the *current* turn's state.
  const turnState: { abort: AbortController | null; watcher: EscWatcher | null } = {
    abort: null,
    watcher: null,
  };

  const askWithSignal: typeof promptApproval = async (decision, input) => {
    const controller = turnState.abort;
    if (controller?.signal.aborted) return "no";
    // Ink owns stdin during the prompt; suspend our raw-mode listener so the
    // two don't fight, and ESC is delivered to Ink's useInput instead.
    turnState.watcher?.suspend();
    // Release the sticky footer so Ink renders above it on a fresh line
    // rather than below the todos.
    screen.detach();
    try {
      const promptOpts: Parameters<typeof promptApproval>[2] = {};
      if (controller) {
        promptOpts.signal = controller.signal;
        promptOpts.onCancel = () => {
          if (!controller.signal.aborted) {
            controller.abort(new Error("interrupted by user"));
          }
        };
      }
      return await promptApproval(decision, input, promptOpts);
    } finally {
      turnState.watcher?.resume();
    }
  };

  const permission = PermissionEngine.fromSettings(settings, askWithSignal);
  const todoStore = new TodoStore();
  const registry = new ToolRegistry().registerAll(builtinTools(todoStore));
  const dispatch = createDispatcher({ registry, logger });

  const checkPermission = async (
    tool: string,
    input: unknown,
  ): Promise<{ granted: boolean; reason?: string }> => {
    try {
      await permission.check({ tool, input: input as Record<string, unknown> });
      return { granted: true };
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        return { granted: false, reason: err.reason };
      }
      return { granted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  const buildModel = (id: string): ModelClient =>
    createAnthropicModel({
      apiKey,
      model: id,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(settings.thinking.format ? { thinkingFormat: settings.thinking.format } : {}),
    });

  let model = buildModel(settings.model);

  let thinkingLevel: ThinkingLevel = settings.thinking.level;
  let thinkingBudgetOverride: number | undefined = settings.thinking.budgetTokens;
  const currentThinkingBudget = (): number => resolveBudget(thinkingLevel, thinkingBudgetOverride);
  const thinkingLevelLabel = (): string | undefined => {
    const budget = currentThinkingBudget();
    if (budget <= 0) return undefined;
    if (thinkingBudgetOverride && thinkingBudgetOverride > 0) {
      return `${budget}t`;
    }
    return thinkingLevel;
  };

  const screen = new Screen();
  const refreshTodoFooter = (): void => {
    screen.setFooter(renderTodoHeader(todoStore.list()));
  };

  const compactor = buildCompactor({
    settings,
    getModel: () => model,
    getSessionDir: () => session.dir,
    onAutoCompact: ({ before, after, transcriptPath }) => {
      const tail = transcriptPath ? ` · snapshot: ${transcriptPath}` : "";
      screen.print(
        `\n${dim(`↻ auto-compacted history ${before} → ${after} msgs${tail}`)}\n`,
      );
      logger.info({ before, after, transcriptPath }, "auto-compacted");
    },
  });

  let spinner: Spinner | null = null;
  const stopSpinner = (finalLine?: string) => {
    if (spinner) {
      spinner.stop(finalLine);
      spinner = null;
    }
  };

  // Tool execution spinner: starts 300ms after a tool enters its execution
  // phase, stops on tool_result. The delay swallows the visual flash for
  // fast tools (Read of small files, Glob with few hits, etc.).
  const TOOL_SPINNER_DELAY_MS = 300;
  let toolSpinnerTimer: NodeJS.Timeout | null = null;
  const armToolSpinner = (toolName: string) => {
    if (toolSpinnerTimer) clearTimeout(toolSpinnerTimer);
    toolSpinnerTimer = setTimeout(() => {
      toolSpinnerTimer = null;
      spinner = screen.startSpinner(
        { words: WORKING_WORDS, tint: CYAN_RGB, colorize: cyan },
        "esc to interrupt",
      );
    }, TOOL_SPINNER_DELAY_MS);
  };
  const clearToolSpinner = () => {
    if (toolSpinnerTimer) {
      clearTimeout(toolSpinnerTimer);
      toolSpinnerTimer = null;
    }
    stopSpinner();
  };

  interface EscWatcher {
    resume(): void;
    suspend(): void;
    dispose(): void;
  }
  const watchForEscape = (onInterrupt: () => void): EscWatcher => {
    const stdin = process.stdin;
    let installed = false;

    const onData = (data: Buffer): void => {
      const s = data.toString("utf8");
      // Bare ESC = abort current turn. Arrow keys / function keys arrive as
      // multi-byte sequences (e.g. "\x1b[A") and won't match this exact test.
      // Ctrl+C also aborts so the user has a way out when we're holding raw mode.
      if (s === "\x1b" || s === "\x03") {
        onInterrupt();
      }
    };

    const install = (): void => {
      if (installed) return;
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return;
      try {
        stdin.setRawMode(true);
        try {
          (stdin as { ref?: () => void }).ref?.();
        } catch {
          // ignore
        }
        stdin.on("data", onData);
        stdin.resume();
        installed = true;
      } catch {
        // ignore — stdin may be in a bad state; we just won't catch ESC.
      }
    };

    const uninstall = (): void => {
      if (!installed) return;
      try {
        stdin.removeListener("data", onData);
      } catch {
        // ignore
      }
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
      installed = false;
    };

    install();
    return { resume: install, suspend: uninstall, dispose: uninstall };
  };

  const pendingUses = new Map<string, { name: string; input: Record<string, unknown> }>();

  // Todo tools are bookkeeping for the agent; the user already sees the
  // resulting list in the footer, so suppress their tool_use/tool_result UI.
  const isTodoTool = (name: string | undefined): boolean =>
    name === "createTodo" || name === "updateTodo" || name === "getTodos";

  const observer: LoopObserver = async (event) => {
    if (!opts.noTranscript) {
      await transcript.append({
        kind: event.kind,
        turn: event.turn,
        data: event.payload,
      });
    }
    if (event.kind === "request_start") {
      spinner = screen.startSpinner(
        { words: WORKING_WORDS, tint: MAGENTA_RGB, colorize: magenta },
        "esc to interrupt",
      );
    } else if (event.kind === "request_end") {
      const p = event.payload as { durationMs: number; error?: string };
      if (p.error) {
        const seconds = (p.durationMs / 1000).toFixed(1);
        const word = spinner?.label() ?? "working";
        stopSpinner(red(`✗ ${word} · ${seconds}s · ${p.error}`));
      } else {
        stopSpinner();
      }
    } else if (event.kind === "assistant") {
      const blocks = blocksOf(event.payload as MessageParam);
      const levelLabel = thinkingLevelLabel();
      for (const block of blocks) {
        if (block.type === "thinking") {
          screen.print(`\n${renderThinking(block.thinking, levelLabel)}\n`);
        } else if (block.type === "redacted_thinking") {
          screen.print(`\n${renderRedactedThinking(levelLabel)}\n`);
        }
      }
      const text = extractText(blocks);
      if (text.trim().length > 0) {
        screen.print(`\n${renderMarkdown(text)}\n`);
      }
    } else if (event.kind === "tool_use") {
      const use = event.payload as { id: string; name: string; input: Record<string, unknown> };
      pendingUses.set(use.id, { name: use.name, input: use.input });
      logger.info({ tool: use.name, input: use.input }, "→ tool_use");
      if (!isTodoTool(use.name)) {
        screen.print(`\n${renderToolUse(use)}\n`);
        // Cover the no-permission-gate path: if no permission_start follows,
        // this timer is what shows the running indicator. permission_start
        // (if any) will cancel it before the interactive prompt opens.
        armToolSpinner(use.name);
      }
    } else if (event.kind === "permission_start") {
      // Entering interactive permission phase — kill any pending/running
      // tool spinner so it does not contend with the prompt UI.
      clearToolSpinner();
    } else if (event.kind === "permission_end") {
      const p = event.payload as { tool: string; granted: boolean };
      if (p.granted) {
        // Re-arm for the actual execution phase.
        armToolSpinner(p.tool);
      }
      // If denied, tool_result follows immediately; no spinner needed.
    } else if (event.kind === "tool_result") {
      clearToolSpinner();
      const r = event.payload as { tool_use_id: string; is_error?: boolean; content: unknown };
      const pending = pendingUses.get(r.tool_use_id);
      if (pending) pendingUses.delete(r.tool_use_id);
      logger.info({ tool: pending?.name, isError: r.is_error ?? false }, "← tool_result");
      if (!isTodoTool(pending?.name)) {
        screen.print(`${renderToolResult(pending?.name, r, pending?.input)}\n`);
      }
      if (pending?.name === "createTodo" || pending?.name === "updateTodo") {
        refreshTodoFooter();
      }
    } else if (event.kind === "compact") {
      const p = event.payload as { from: number; to: number };
      logger.debug({ from: p.from, to: p.to }, "compact applied");
    }
  };

  const renderHistory = (msgs: MessageParam[]): void => {
    if (msgs.length === 0) return;
    process.stdout.write(`\n${dim("─── history ───")}\n`);
    const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
    for (const msg of msgs) {
      const blocks = blocksOf(msg);
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          process.stdout.write(`\n${green(">")} ${msg.content}\n`);
          continue;
        }
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const pending = toolUses.get(block.tool_use_id);
            process.stdout.write(
              `\n${renderToolResult(pending?.name, { is_error: block.is_error, content: block.content }, pending?.input)}\n`,
            );
            if (pending) toolUses.delete(block.tool_use_id);
          } else if (block.type === "text") {
            process.stdout.write(`\n${green(">")} ${block.text}\n`);
          }
        }
        continue;
      }
      for (const block of blocks) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            process.stdout.write(`\n${renderMarkdown(block.text)}\n`);
          }
        } else if (block.type === "tool_use") {
          toolUses.set(block.id, { name: block.name, input: block.input });
          process.stdout.write(`\n${renderToolUse(block)}\n`);
        } else if (block.type === "thinking") {
          process.stdout.write(`\n${renderThinking(block.thinking)}\n`);
        } else if (block.type === "redacted_thinking") {
          process.stdout.write(`\n${renderRedactedThinking()}\n`);
        }
      }
    }
    process.stdout.write(`\n${dim("─── end of history ───")}\n`);
  };

  let messages: MessageParam[] = [];
  let persistCursor: PersistCursor = emptyCursor;
  if (resumed) {
    try {
      messages = await loadMessages(session.messagesPath);
      persistCursor =
        messages.length === 0
          ? emptyCursor
          : {
              count: messages.length,
              lastLine: JSON.stringify(messages[messages.length - 1]),
            };
      process.stdout.write(`${dim(`loaded ${messages.length} message(s) from disk`)}\n`);
      logger.info({ count: messages.length }, "messages restored");
      renderHistory(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${red(`✗ failed to load messages: ${msg}`)}\n`);
      logger.error({ err: msg }, "failed to load messages");
      process.exit(2);
    }
  }

  const persist = async (): Promise<void> => {
    try {
      persistCursor = await persistMessages(session.messagesPath, messages, persistCursor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "failed to persist messages");
      process.stderr.write(`${dim(`(warning: persist failed — ${msg})`)}\n`);
    }
  };

  const switchToSession = async (newSession: Session): Promise<boolean> => {
    let newMessages: MessageParam[];
    try {
      newMessages = await loadMessages(newSession.messagesPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${red(`✗ failed to load messages from ${newSession.id}: ${msg}`)}\n`);
      logger.error({ err: msg, target: newSession.id }, "resume failed");
      return false;
    }

    await transcript.flush();

    session = newSession;
    logPath = join(session.dir, "session.log");
    logger = buildLogger(logPath);
    transcript = new Transcript(session.transcriptPath);
    messages = newMessages;
    persistCursor =
      messages.length === 0
        ? emptyCursor
        : {
            count: messages.length,
            lastLine: JSON.stringify(messages[messages.length - 1]),
          };
    resumed = true;

    await transcript.append({
      kind: "session_start",
      data: { id: session.id, cwd: workspace, model: settings.model, resumed: true },
    });
    if (memory.sources.length > 0) {
      await transcript.append({ kind: "memory_loaded", data: { sources: memory.sources } });
    }

    clearScreen();
    printBanner();
    process.stdout.write(
      `${dim(`↻ resumed ${session.id} · log: ${logPath} · ${messages.length} message(s)`)}\n`,
    );
    renderHistory(messages);
    logger.info(
      { sessionId: session.id, dir: session.dir, messageCount: messages.length },
      "session resumed via /resume",
    );
    return true;
  };

  const runTurn = async (userInput: string): Promise<boolean> => {
    const beforeMessageCount = messages.length;
    messages.push(userText(userInput));
    await transcript.append({ kind: "user_prompt", data: { text: userInput } });

    const abortController = new AbortController();
    const watcher = watchForEscape(() => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error("interrupted by user"));
      }
    });
    turnState.abort = abortController;
    turnState.watcher = watcher;

    try {
      const budget = currentThinkingBudget();
      const result = await agentLoop({
        model,
        system: buildSystemPrompt(workspace, memory, session.id),
        tools: registry.definitions(),
        executeTool: dispatch,
        messages,
        maxTokens: settings.maxTokens,
        maxTurns: settings.maxTurns,
        toolContext: {
          cwd: workspace,
          signal: abortController.signal,
          askUser: async (req) => {
            clearToolSpinner();
            watcher.suspend();
            screen.detach();
            try {
              return await askUser(req, { signal: abortController.signal });
            } finally {
              watcher.resume();
            }
          },
        },
        checkPermission,
        observer,
        compactor,
        interject: makeTodoReminder(todoStore),
        ...(budget > 0 ? { thinkingBudgetTokens: budget } : {}),
      });

      messages = result.messages;
      await persist();

      logger.info(
        {
          turns: result.turns,
          stopReason: result.stopReason,
          usage: result.totalUsage,
        },
        "loop finished",
      );
      screen.print(
        `\n${green("done")} ${dim(`· ${result.turns} turn(s) · ${result.stopReason} · in=${result.totalUsage.inputTokens} out=${result.totalUsage.outputTokens}`)}\n`,
      );
      await transcript.flush();
      return true;
    } catch (err) {
      stopSpinner();
      if (abortController.signal.aborted) {
        // Roll back the user message so the conversation state stays valid
        // (no dangling user turn without an assistant reply).
        messages.length = beforeMessageCount;
        screen.print(`\n${dim("✗ interrupted by user (esc)")}\n`);
        logger.info({}, "loop interrupted by user");
        await transcript.append({ kind: "error", data: { message: "interrupted by user" } });
        await transcript.flush();
      } else {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        logger.error({ err: msg }, "loop terminated");
        const head = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        screen.printErr(
          `\n${red(`✗ loop terminated — ${head}`)}\n  ${dim(`see log: ${logPath}`)}\n`,
        );
        await transcript.append({ kind: "error", data: { message: msg } });
        await transcript.flush();
      }
      return false;
    } finally {
      turnState.abort = null;
      turnState.watcher = null;
      watcher.dispose();
    }
  };

  let nextPlaceholder = "";
  const refreshPrediction = async (): Promise<void> => {
    if (!settings.predict.enabled) return;
    if (messages.length === 0) return;
    spinner = screen.startSpinner({
      words: ["Thinking ahead..."],
      tint: CYAN_RGB,
      colorize: cyan,
    });
    const t0 = Date.now();
    try {
      const result = await predictNextInput({
        model,
        messages,
        maxChars: settings.predict.maxChars,
        timeoutMs: settings.predict.timeoutMs,
        ...(memory.system ? { memorySystem: memory.system } : {}),
      });
      stopSpinner();
      const durationMs = Date.now() - t0;
      if (result.text) {
        nextPlaceholder = result.text;
        logger.debug({ text: result.text, durationMs }, "predict ok");
      } else {
        logger.info(
          { error: result.error, raw: result.raw, durationMs },
          "predict produced no placeholder",
        );
      }
    } catch (err) {
      stopSpinner();
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "predict threw");
    }
  };

  if (initialPrompt) {
    const ok = await runTurn(initialPrompt);
    if (ok) await refreshPrediction();
  }

  process.stdout.write(`\n${dim("REPL ready. Type /help for commands, /exit to quit.")}\n`);

  while (true) {
    screen.detach();
    process.stdout.write("\n");
    const placeholder = nextPlaceholder;
    nextPlaceholder = "";
    const raw = await readBoxedLine({
      commands: SLASH_COMMANDS,
      ...(placeholder ? { placeholder } : {}),
    });
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      process.stdout.write(`\n${HELP_TEXT}\n`);
      continue;
    }
    if (line === "/clear") {
      messages = [];
      nextPlaceholder = "";
      await persist();
      clearScreen();
      printBanner();
      continue;
    }
    if (line === "/compact" || line.startsWith("/compact ")) {
      process.stdout.write("\n");
      const focus = line.slice("/compact".length).trim();
      if (messages.length === 0) {
        process.stdout.write(`${dim("nothing to compact (empty history).")}\n`);
        continue;
      }
      spinner = screen.startSpinner("compacting");
      try {
        const result = await manualCompact(messages, {
          settings,
          getModel: () => model,
          getSessionDir: () => session.dir,
          ...(focus ? { focus } : {}),
        });
        messages = result.messages;
        nextPlaceholder = "";
        await persist();
        const seconds = (spinner.elapsedMs() / 1000).toFixed(1);
        const tail = result.transcriptPath ? ` · snapshot: ${result.transcriptPath}` : "";
        stopSpinner(
          `${green("✓")} ${dim(`compacted · ${seconds}s · ${result.before} → ${result.after} msgs${tail}`)}`,
        );
        logger.info(
          {
            before: result.before,
            after: result.after,
            transcriptPath: result.transcriptPath,
            focus: focus || undefined,
          },
          "manual /compact",
        );
        await transcript.append({
          kind: "compact",
          data: {
            before: result.before,
            after: result.after,
            transcriptPath: result.transcriptPath,
            focus: focus || undefined,
            trigger: "manual",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stopSpinner(red(`✗ compact failed · ${msg}`));
        logger.error({ err: msg }, "manual /compact failed");
      }
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      process.stdout.write("\n");
      const arg = line.slice("/resume".length).trim();
      const list = await listSessions(settings.sessionDir);
      if (list.length === 0) {
        process.stdout.write(`${dim("no sessions to resume.")}\n`);
        continue;
      }

      let target: Session | null = null;

      if (arg) {
        target = list.find((s) => s.id === arg) ?? null;
        if (!target) {
          process.stdout.write(`${red(`session ${arg} not found.`)}\n`);
          continue;
        }
      } else {
        type PickerItem = { session: Session; label: string };
        const items: PickerItem[] = [];
        for (const s of list) {
          let label: string;
          try {
            const msgs = await loadMessages(s.messagesPath);
            if (msgs.length === 0) continue;
            label = firstUserLabel(msgs);
          } catch (err) {
            const m = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
            label = red(`load failed: ${m.slice(0, 60)}`);
          }
          items.push({ session: s, label });
        }
        if (items.length === 0) {
          process.stdout.write(`${dim("no sessions to resume.")}\n`);
          continue;
        }
        const currentIdx = items.findIndex((it) => it.session.id === session.id);
        const pick = await pickOne<PickerItem>({
          items,
          header: dim("select session to resume:"),
          footer: dim("↑↓ navigate · enter confirm · esc cancel"),
          pageSize: 10,
          initialIndex: currentIdx >= 0 ? currentIdx : 0,
          render: ({ session: s, label }, isSelected) => {
            const marker = s.id === session.id ? green("*") : " ";
            return `${pickerArrow(isSelected)} ${marker} ${s.id}  ${dim(formatTimestamp(s.createdAt))}  ${dim(label)}`;
          },
        });
        if (!pick) {
          process.stdout.write(`${dim("cancelled.")}\n`);
          continue;
        }
        target = pick.session;
      }

      if (target.id === session.id) {
        process.stdout.write(`${dim("already on that session.")}\n`);
        continue;
      }
      nextPlaceholder = "";
      await switchToSession(target);
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      process.stdout.write("\n");
      const arg = line.slice("/model".length).trim();
      if (!arg) {
        process.stdout.write(`${dim("model:")} ${settings.model}\n`);
      } else {
        settings.model = arg;
        model = buildModel(arg);
        try {
          await saveSettings({ model: arg });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
        }
        process.stdout.write(`${dim("model set to")} ${arg}\n`);
      }
      continue;
    }
    if (line === "/predict" || line.startsWith("/predict ")) {
      process.stdout.write("\n");
      const arg = line.slice("/predict".length).trim();
      if (!arg) {
        process.stdout.write(
          `${dim("predict:")} ${settings.predict.enabled ? "on" : "off"}\n`,
        );
      } else if (arg === "on" || arg === "off") {
        settings.predict.enabled = arg === "on";
        if (!settings.predict.enabled) nextPlaceholder = "";
        try {
          await saveSettings({ predict: settings.predict });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
        }
        process.stdout.write(`${dim("predict set to")} ${arg}\n`);
      } else {
        process.stdout.write(`${red("✗")} ${dim("expected on or off")}\n`);
      }
      continue;
    }
    if (line === "/think" || line.startsWith("/think ")) {
      process.stdout.write("\n");
      const arg = line.slice("/think".length).trim();
      const persistThinking = async (): Promise<void> => {
        settings.thinking.level = thinkingLevel;
        settings.thinking.budgetTokens = thinkingBudgetOverride;
        try {
          await saveSettings({ thinking: settings.thinking });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
        }
      };
      if (!arg) {
        const currentIdx = THINKING_LEVELS.indexOf(thinkingLevel);
        const pick = await pickHorizontal<ThinkingLevel>({
          items: [...THINKING_LEVELS],
          header: dim("select thinking level:"),
          footer: dim("← → navigate · enter confirm · esc cancel"),
          initialIndex: currentIdx >= 0 ? currentIdx : 0,
          label: (level) => level,
        });
        if (!pick) {
          process.stdout.write(`${dim("cancelled.")}\n`);
          continue;
        }
        thinkingLevel = pick;
        thinkingBudgetOverride = undefined;
        await persistThinking();
        process.stdout.write(`${dim("thinking set to")} ${pick}\n`);
      } else {
        const asNumber = Number.parseInt(arg, 10);
        if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
          thinkingBudgetOverride = asNumber;
          await persistThinking();
          process.stdout.write(
            `${dim("thinking budget set to")} ${asNumber} ${dim(`tokens (level: ${thinkingLevel})`)}\n`,
          );
        } else if (isThinkingLevel(arg)) {
          thinkingLevel = arg;
          thinkingBudgetOverride = undefined;
          await persistThinking();
          process.stdout.write(`${dim("thinking set to")} ${arg}\n`);
        } else {
          process.stdout.write(
            `${red("✗")} ${dim("expected off|low|medium|high|max or a positive integer")}\n`,
          );
        }
      }
      continue;
    }

    todoStore.clear();
    refreshTodoFooter();
    const ok = await runTurn(line);
    if (ok) await refreshPrediction();
  }

  process.stdout.write(`\nBye!\n`);
  await transcript.flush();
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
