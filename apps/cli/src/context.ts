import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemory, type MemoryBundle } from "@nova/context";
import {
  createAnthropicModel,
  resolveBudget,
  type MessageParam,
  type ModelClient,
  type ThinkingLevel,
  type ToolExecutor,
} from "@nova/core";
import { Transcript } from "@nova/observability";
import { TodoStore } from "@nova/orchestration";
import {
  createLogger,
  type Logger,
  type Session,
  type Settings,
} from "@nova/runtime";
import {
  PermissionDeniedError,
  PermissionEngine,
  promptApproval,
} from "@nova/safety";
import { ToolRegistry, builtinTools, createDispatcher } from "@nova/tools";
import { renderBanner } from "./banner.js";
import { CYAN_RGB, cyan, dim, red } from "./colors.js";
import { buildCompactor } from "./compactor.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import type { EscWatcher } from "./esc-watcher.js";
import {
  emptyCursor,
  loadMessages,
  persistMessages,
  type PersistCursor,
} from "./persistence.js";
import { renderHistory, resolveSession } from "./session-view.js";
import { Screen, type Spinner } from "./screen.js";
import { renderTodoHeader } from "./todo-footer.js";

export interface CliRuntimeOptions {
  cwd?: string;
  resume?: string;
  continue?: boolean;
  noTranscript?: boolean;
  noPretty?: boolean;
}

/**
 * The shared mutable state that the REPL, slash commands, and runTurn all
 * read and mutate. Everything that used to live in run()'s closure now lives
 * here. Helpers exported from this module take `ctx` as their first arg.
 */
export interface CliContext {
  // ===== Mutable: changes on /resume =====
  session: Session;
  logger: Logger;
  logPath: string;
  transcript: Transcript;
  messages: MessageParam[];
  persistCursor: PersistCursor;
  resumed: boolean;

  // ===== Mutable: changes on /model, /think, /predict =====
  settings: Settings;
  model: ModelClient;
  thinkingLevel: ThinkingLevel;
  thinkingBudgetOverride: number | undefined;

  // ===== Mutable: UI / per-turn state =====
  spinner: Spinner | null;
  toolSpinnerTimer: NodeJS.Timeout | null;
  nextPlaceholder: string;
  pendingUses: Map<string, { name: string; input: Record<string, unknown> }>;
  /**
   * Shared ref-box for the per-turn AbortController and ESC watcher. The
   * persistent permission ask callback reads through this box to see the
   * *current* turn's controller.
   */
  turnState: { abort: AbortController | null; watcher: EscWatcher | null };

  // ===== Read-only after init =====
  readonly apiKey: string;
  readonly workspace: string;
  readonly memory: MemoryBundle;
  readonly version: string;
  readonly noTranscript: boolean;
  readonly noPretty: boolean;
  readonly screen: Screen;
  readonly todoStore: TodoStore;
  readonly registry: ToolRegistry;
  readonly dispatch: ToolExecutor;
  readonly permission: PermissionEngine;
  readonly checkPermission: (
    tool: string,
    input: unknown,
  ) => Promise<{ granted: boolean; reason?: string }>;
  readonly compactor: (messages: MessageParam[]) => Promise<MessageParam[]>;

  // ===== Factory closures (close over apiKey / settings, etc.) =====
  readonly buildLogger: (destination: string) => Logger;
  readonly buildModel: (id: string) => ModelClient;
}

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

export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

export function printBanner(ctx: CliContext): void {
  process.stdout.write(
    `\n${renderBanner({
      version: ctx.version,
      model: ctx.settings.model,
      cwd: ctx.workspace,
      home: homedir(),
      sessionId: ctx.session.id,
    })}\n`,
  );
}

export function refreshTodoFooter(ctx: CliContext): void {
  ctx.screen.setFooter(renderTodoHeader(ctx.todoStore.list()));
}

export function stopSpinner(ctx: CliContext, finalLine?: string): void {
  if (ctx.spinner) {
    ctx.spinner.stop(finalLine);
    ctx.spinner = null;
  }
}

/**
 * Tool execution spinner: starts 300ms after a tool enters its execution
 * phase, stops on tool_result. The delay swallows the visual flash for fast
 * tools (Read of small files, Glob with few hits, etc.).
 */
export function armToolSpinner(ctx: CliContext): void {
  if (ctx.toolSpinnerTimer) clearTimeout(ctx.toolSpinnerTimer);
  ctx.toolSpinnerTimer = setTimeout(() => {
    ctx.toolSpinnerTimer = null;
    ctx.spinner = ctx.screen.startSpinner(
      { words: WORKING_WORDS, tint: CYAN_RGB, colorize: cyan },
      "esc to interrupt",
    );
  }, TOOL_SPINNER_DELAY_MS);
}

export function clearToolSpinner(ctx: CliContext): void {
  if (ctx.toolSpinnerTimer) {
    clearTimeout(ctx.toolSpinnerTimer);
    ctx.toolSpinnerTimer = null;
  }
  stopSpinner(ctx);
}

export async function persist(ctx: CliContext): Promise<void> {
  try {
    ctx.persistCursor = await persistMessages(
      ctx.session.messagesPath,
      ctx.messages,
      ctx.persistCursor,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ err: msg }, "failed to persist messages");
    process.stderr.write(`${dim(`(warning: persist failed — ${msg})`)}\n`);
  }
}

export function currentThinkingBudget(ctx: CliContext): number {
  return resolveBudget(ctx.thinkingLevel, ctx.thinkingBudgetOverride);
}

export function thinkingLevelLabel(ctx: CliContext): string | undefined {
  const budget = currentThinkingBudget(ctx);
  if (budget <= 0) return undefined;
  if (ctx.thinkingBudgetOverride && ctx.thinkingBudgetOverride > 0) {
    return `${budget}t`;
  }
  return ctx.thinkingLevel;
}

export async function createContext(
  settings: Settings,
  cliOpts: CliRuntimeOptions,
): Promise<CliContext> {
  const apiKey = settings.apiKey;
  if (!apiKey) {
    // Caller (index.ts) is expected to check; defensive throw so internal
    // misuse doesn't silently coerce to "".
    throw new Error("apiKey is not set in settings");
  }

  const workspace = cliOpts.cwd ?? process.cwd();
  const noPretty = cliOpts.noPretty ?? false;
  const noTranscript = cliOpts.noTranscript ?? false;

  const memoryOpts: Parameters<typeof loadMemory>[1] = {
    filenames: settings.memory.filenames,
    ...(settings.memory.userPaths ? { userPaths: settings.memory.userPaths } : {}),
    ...(settings.memory.globalPath ? { globalPath: settings.memory.globalPath } : {}),
  };
  const memory = await loadMemory(workspace, memoryOpts);
  const version = await readCliVersion();

  const { session, resumed } = await resolveSession(cliOpts, settings.sessionDir);

  const buildLogger = (destination: string): Logger =>
    createLogger({
      level: settings.logging.level,
      pretty: settings.logging.pretty && !noPretty,
      destination,
    });
  const logPath = join(session.dir, "session.log");
  const logger = buildLogger(logPath);

  const transcript = new Transcript(session.transcriptPath);
  await transcript.append({
    kind: "session_start",
    data: { id: session.id, cwd: workspace, model: settings.model, resumed },
  });
  if (memory.sources.length > 0) {
    await transcript.append({ kind: "memory_loaded", data: { sources: memory.sources } });
  }

  const screen = new Screen();
  const todoStore = new TodoStore();
  const registry = new ToolRegistry().registerAll(builtinTools(todoStore));
  const dispatch = createDispatcher({ registry, logger });

  const buildModel = (id: string): ModelClient =>
    createAnthropicModel({
      apiKey,
      model: id,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(settings.thinking.format ? { thinkingFormat: settings.thinking.format } : {}),
    });

  // Build ctx as a shell first, then attach helpers that close over ctx
  // itself (compactor reads ctx.model / ctx.session.dir, askWithSignal reads
  // ctx.turnState, etc.). The non-null casts on the fields populated below
  // keep the public type honest.
  const ctx: CliContext = {
    session,
    logger,
    logPath,
    transcript,
    messages: [],
    persistCursor: emptyCursor,
    resumed,
    settings,
    model: buildModel(settings.model),
    thinkingLevel: settings.thinking.level,
    thinkingBudgetOverride: settings.thinking.budgetTokens,
    spinner: null,
    toolSpinnerTimer: null,
    nextPlaceholder: "",
    pendingUses: new Map(),
    turnState: { abort: null, watcher: null },
    apiKey,
    workspace,
    memory,
    version,
    noTranscript,
    noPretty,
    screen,
    todoStore,
    registry,
    dispatch,
    permission: null as unknown as PermissionEngine,
    checkPermission: null as unknown as CliContext["checkPermission"],
    compactor: null as unknown as CliContext["compactor"],
    buildLogger,
    buildModel,
  };

  // askWithSignal: bridges the persistent permission engine into the
  // *current* turn's abort controller. Ink owns stdin during the prompt, so
  // we suspend our raw-mode listener and detach the sticky footer.
  const askWithSignal: typeof promptApproval = async (decision, input) => {
    const controller = ctx.turnState.abort;
    if (controller?.signal.aborted) return "no";
    ctx.turnState.watcher?.suspend();
    ctx.screen.detach();
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
      ctx.turnState.watcher?.resume();
    }
  };

  const permission = PermissionEngine.fromSettings(settings, askWithSignal);
  (ctx as { permission: PermissionEngine }).permission = permission;

  (ctx as { checkPermission: CliContext["checkPermission"] }).checkPermission = async (
    tool,
    input,
  ) => {
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

  (ctx as { compactor: CliContext["compactor"] }).compactor = buildCompactor({
    settings,
    getModel: () => ctx.model,
    getSessionDir: () => ctx.session.dir,
    onAutoCompact: ({ before, after, transcriptPath }) => {
      const tail = transcriptPath ? ` · snapshot: ${transcriptPath}` : "";
      ctx.screen.print(
        `\n${dim(`↻ auto-compacted history ${before} → ${after} msgs${tail}`)}\n`,
      );
      ctx.logger.info({ before, after, transcriptPath }, "auto-compacted");
    },
  });

  // Initial banner + log lines mirror the original startup order.
  if (resumed) clearScreen();
  printBanner(ctx);
  logger.info(
    { sessionId: session.id, dir: session.dir, resumed },
    resumed ? "session resumed" : "session started",
  );
  if (memory.sources.length > 0) {
    logger.info({ sources: memory.sources }, "memory loaded");
  }

  // Restore messages from disk if resuming.
  if (resumed) {
    try {
      const msgs = await loadMessages(session.messagesPath);
      ctx.messages = msgs;
      ctx.persistCursor =
        msgs.length === 0
          ? emptyCursor
          : {
              count: msgs.length,
              lastLine: JSON.stringify(msgs[msgs.length - 1]),
            };
      process.stdout.write(`${dim(`loaded ${msgs.length} message(s) from disk`)}\n`);
      logger.info({ count: msgs.length }, "messages restored");
      renderHistory(msgs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${red(`✗ failed to load messages: ${msg}`)}\n`);
      logger.error({ err: msg }, "failed to load messages");
      process.exit(2);
    }
  }

  return ctx;
}
