import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemory, type MemoryBundle } from "@nova/context";
import {
  createAnthropicModel,
  resolveBudget,
  type FileAccessLedger,
  type MessageParam,
  type ModelClient,
  type ThinkingLevel,
  type ToolExecutor,
} from "@nova/core";
import { SlashRegistry } from "@nova/external";
import { Transcript } from "@nova/observability";
import { TodoStore } from "@nova/orchestration";
import {
  createLogger,
  type Logger,
  type Session,
  type Settings,
} from "@nova/runtime";
import { PermissionDeniedError, PermissionEngine } from "@nova/safety";
import {
  InMemoryFileAccessLedger,
  ToolRegistry,
  builtinTools,
  createDispatcher,
  createInvariants,
} from "@nova/tools";
import { CYAN_RGB, cyan, dim } from "./colors.js";
import { buildCompactor } from "./compactor.js";
import { resolvePermissionRules } from "./permissions.js";
import {
  handleClear,
  handleCommands,
  handleCompact,
  handleHelp,
  handleModel,
  handlePredict,
  handleResume,
  handleThink,
} from "./commands/index.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import { loadFileCommandsInto } from "./slash.js";
import {
  emptyCursor,
  loadMessages,
  persistMessages,
  type PersistCursor,
} from "./persistence.js";
import { resolveSession } from "./session.js";
import { Screen, fatalExit, type Spinner } from "./screen.js";

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
  /**
   * Carrier for the auto-compact summary card across the compactor →
   * compact_end window. The compactor's onAutoCompact callback stashes the
   * info here; the observer's compact_end handler reads it back after the
   * mandatory `clearCards()` and pushes the card, so the notice survives.
   */
  pendingAutoCompactNotice: { before: number; after: number; transcriptPath?: string } | null;
  /**
   * Shared ref-box for the per-turn AbortController. The persistent
   * permission ask callback reads through this box to see the *current*
   * turn's controller.
   */
  turnState: { abort: AbortController | null };

  // ===== Read-only after init =====
  readonly apiKey: string;
  readonly workspace: string;
  readonly memory: MemoryBundle;
  readonly version: string;
  readonly noTranscript: boolean;
  readonly noPretty: boolean;
  readonly screen: Screen;
  readonly todoStore: TodoStore;
  readonly registry: SlashRegistry;
  readonly tools: ToolRegistry;
  readonly dispatch: ToolExecutor;
  readonly fileLedger: FileAccessLedger;
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

export function refreshBanner(ctx: CliContext): void {
  ctx.screen.setBanner({
    version: ctx.version,
    model: ctx.settings.model,
    cwd: ctx.workspace,
    home: homedir(),
    sessionId: ctx.session.id,
  });
}

export function refreshTodoFooter(ctx: CliContext): void {
  ctx.screen.setTodos(ctx.todoStore.list());
}

export function stopSpinner(ctx: CliContext): void {
  if (ctx.spinner) {
    ctx.spinner.stop();
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
      ctx.screen.getMessages(),
      ctx.persistCursor,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ err: msg }, "failed to persist messages");
    ctx.screen.card(msg, { kind: "warn", title: "persist failed" });
  }
}

export function currentThinkingBudget(ctx: CliContext): number {
  return resolveBudget(ctx.thinkingLevel, ctx.thinkingBudgetOverride);
}

function registerBuiltinSlashCommands(ctx: CliContext): void {
  const handled = { kind: "handled" as const };
  ctx.registry.register({
    name: "help",
    description: "show this help",
    source: { kind: "builtin" },
    run: () => {
      handleHelp(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "model",
    description: "show or change the active model",
    argHint: "[<name>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleModel(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "think",
    description: "show or change the extended-thinking level",
    argHint: "[<level>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleThink(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "clear",
    description: "clear conversation history (keeps session)",
    source: { kind: "builtin" },
    run: async () => {
      await handleClear(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "compact",
    description: "summarize history into a single message",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCompact(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "resume",
    description: "switch to a saved session",
    argHint: "[<id>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleResume(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "predict",
    description: "show or toggle next-input prediction",
    argHint: "[on|off]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handlePredict(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "commands",
    description: "list registered slash commands; use `reload` to rescan files",
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCommands(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "exit",
    description: "leave the REPL",
    source: { kind: "builtin" },
    run: () => handled,
  });
  ctx.registry.register({
    name: "quit",
    description: "leave the REPL",
    source: { kind: "builtin" },
    run: () => handled,
  });
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
  screen: Screen,
  cliOpts: CliRuntimeOptions,
): Promise<CliContext> {
  const apiKey = settings.apiKey;
  if (!apiKey) {
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

  const todoStore = new TodoStore();
  const tools = new ToolRegistry().registerAll(builtinTools(todoStore));
  const fileLedger = new InMemoryFileAccessLedger();
  const invariants = settings.invariants.enabled
    ? createInvariants({
        readBeforeEdit: settings.invariants.readBeforeEdit,
        mtimeCheck: settings.invariants.mtimeCheck,
      })
    : undefined;
  const dispatch = createDispatcher({
    registry: tools,
    logger,
    ...(invariants ? { invariants } : {}),
  });
  const registry = new SlashRegistry();

  const buildModel = (id: string): ModelClient =>
    createAnthropicModel({
      apiKey,
      model: id,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(settings.thinking.format ? { thinkingFormat: settings.thinking.format } : {}),
    });

  const ctx: CliContext = {
    session,
    logger,
    logPath,
    transcript,
    persistCursor: emptyCursor,
    resumed,
    settings,
    model: buildModel(settings.model),
    thinkingLevel: settings.thinking.level,
    thinkingBudgetOverride: settings.thinking.budgetTokens,
    spinner: null,
    toolSpinnerTimer: null,
    nextPlaceholder: "",
    pendingAutoCompactNotice: null,
    turnState: { abort: null },
    apiKey,
    workspace,
    memory,
    version,
    noTranscript,
    noPretty,
    screen,
    todoStore,
    registry,
    tools,
    dispatch,
    fileLedger,
    permission: null as unknown as PermissionEngine,
    checkPermission: null as unknown as CliContext["checkPermission"],
    compactor: null as unknown as CliContext["compactor"],
    buildLogger,
    buildModel,
  };

  // Permission ask bridges into the current turn's abort controller so a
  // long-pending prompt gets cancelled when the user hits Esc.
  const askWithSignal: Screen["promptApproval"] = async (decision, input) => {
    const controller = ctx.turnState.abort;
    if (controller?.signal.aborted) return "no";
    const promptOpts: Parameters<Screen["promptApproval"]>[2] = {};
    if (controller) {
      promptOpts.signal = controller.signal;
      promptOpts.onCancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(new Error("interrupted by user"));
        }
      };
    }
    return await ctx.screen.promptApproval(decision, input, promptOpts);
  };

  const permission = new PermissionEngine({
    defaultEffect: settings.permissions.defaultEffect,
    rules: resolvePermissionRules(settings, workspace),
    ask: askWithSignal,
  });
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
      ctx.pendingAutoCompactNotice = {
        before,
        after,
        ...(transcriptPath ? { transcriptPath } : {}),
      };
      ctx.logger.info({ before, after, transcriptPath }, "auto-compacted");
    },
  });

  registerBuiltinSlashCommands(ctx);
  const loaded = await loadFileCommandsInto(ctx.registry, {
    cwd: workspace,
    settings,
    logger,
  });
  if (loaded.added > 0 || loaded.errors > 0) {
    logger.info({ ...loaded }, "slash commands loaded");
  }

  // For resumed sessions, wipe whatever is already on screen (setup wizard
  // output, previous scrollback, etc.) so the loaded history shows cleanly.
  if (resumed) await ctx.screen.reset();

  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  refreshBanner(ctx);
  logger.info(
    { sessionId: session.id, dir: session.dir, resumed },
    resumed ? "session resumed" : "session started",
  );
  if (memory.sources.length > 0) {
    logger.info({ sources: memory.sources }, "memory loaded");
  }

  if (resumed) {
    try {
      const msgs = await loadMessages(session.messagesPath);
      ctx.persistCursor =
        msgs.length === 0
          ? emptyCursor
          : {
              count: msgs.length,
              lastLine: JSON.stringify(msgs[msgs.length - 1]),
            };
      // Push the "loaded N" card before setMessages so its anchor (-1) puts
      // it above the restored history rather than below it.
      ctx.screen.card(dim(`loaded ${msgs.length} message(s) from disk`));
      ctx.screen.setMessages(msgs);
      logger.info({ count: msgs.length }, "messages restored");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "failed to load messages");
      await fatalExit(ctx.screen, `failed to load messages: ${msg}`);
    }
  }

  return ctx;
}
