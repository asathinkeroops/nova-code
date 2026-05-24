import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
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
import { PermissionDeniedError, PermissionEngine } from "@nova/safety";
import { ToolRegistry, builtinTools, createDispatcher } from "@nova/tools";
import { CYAN_RGB, cyan, dim, red } from "./colors.js";
import { buildCompactor } from "./compactor.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import {
  emptyCursor,
  loadMessages,
  persistMessages,
  type PersistCursor,
} from "./persistence.js";
import { resolveSession } from "./session.js";
import { Screen, type Spinner } from "./screen.js";
import { Banner } from "./ui/banner.js";

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

export function printBanner(ctx: CliContext): void {
  ctx.screen.print("\n");
  ctx.screen.printNode(
    React.createElement(Banner, {
      version: ctx.version,
      model: ctx.settings.model,
      cwd: ctx.workspace,
      home: homedir(),
      sessionId: ctx.session.id,
    }),
  );
  ctx.screen.print("\n");
}

export function refreshTodoFooter(ctx: CliContext): void {
  ctx.screen.setTodos(ctx.todoStore.list());
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
    ctx.screen.printErr(`${dim(`(warning: persist failed — ${msg})`)}\n`);
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
  const registry = new ToolRegistry().registerAll(builtinTools(todoStore));
  const dispatch = createDispatcher({ registry, logger });

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
    dispatch,
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

  // For resumed sessions, wipe whatever is already on screen (setup wizard
  // output, previous scrollback, etc.) so the loaded history shows cleanly.
  if (resumed) await ctx.screen.reset();

  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  printBanner(ctx);
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
      ctx.messages = msgs;
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
      ctx.screen.printErr(`${red(`✗ failed to load messages: ${msg}`)}\n`);
      logger.error({ err: msg }, "failed to load messages");
      await ctx.screen.unmount();
      process.exit(2);
    }
  }

  return ctx;
}
