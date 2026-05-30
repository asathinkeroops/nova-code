import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgent,
  emptyCursor,
  loadMessages,
  type Agent,
  type PersistCursor,
} from "@nova/agent";
import { loadMemory, type MemoryBundle } from "@nova/context";
import {
  createAnthropicModel,
  resolveBudget,
  type AskUserFn,
  type FileAccessLedger,
  type MessageParam,
  type ModelClient,
  type ThinkingLevel,
  type ToolExecutor,
} from "@nova/core";
import { SlashRegistry } from "@nova/external";
import { Transcript } from "@nova/observability";
import {
  LongRunningCommandManager,
  TaskStore,
  TodoStore,
  makeLongRunningNotifier,
  makeTaskReminder,
  makeTodoReminder,
  type InterjectFn,
} from "@nova/tools";
import {
  createLogger,
  type Logger,
  type Session,
  type Settings,
} from "@nova/runtime";
import { PermissionDeniedError, PermissionEngine } from "@nova/safety";
import { createSubAgentTool } from "@nova/subagent";
import {
  InMemoryFileAccessLedger,
  ToolRegistry,
  builtinTools,
  createDispatcher,
  createInvariants,
  getSkillList,
  type SkillsOptions,
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
  handlePlan,
  handlePredict,
  handleResume,
  handleRewind,
  handleSkills,
  handleThink,
} from "./commands/index.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import { registerUiHooks } from "./hooks.js";
import { SnapshotStore } from "./snapshots.js";
import { renderSkillsBlock } from "./skills-render.js";
import { loadFileCommandsInto } from "./slash.js";
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
  /** Per-session file snapshotter backing `/rewind`. Rebuilt on /resume. */
  snapshots: SnapshotStore;

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
   * post_compact window. The compactor's onAutoCompact callback stashes the
   * info here; the post_compact UI hook reads it back after the mandatory
   * `clearCards()` and pushes the card, so the notice survives.
   */
  pendingAutoCompactNotice: { before: number; after: number; transcriptPath?: string } | null;

  // ===== Read-only after init =====
  readonly agent: Agent;
  readonly apiKey: string;
  readonly workspace: string;
  readonly memory: MemoryBundle;
  /**
   * Pre-rendered `<available-skills>` block injected into the system prompt.
   * Empty string when skills are disabled or no SKILL.md files were found.
   */
  readonly skillsBlock: string;
  readonly version: string;
  readonly noTranscript: boolean;
  readonly noPretty: boolean;
  readonly screen: Screen;
  readonly todoStore: TodoStore;
  readonly taskStore: TaskStore;
  readonly longRunningManager: LongRunningCommandManager;
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

/** Current branch of the workspace repo, or null when not a repo / detached. */
function currentGitBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    return null;
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
  ctx.screen.setStatusMeta({
    sessionStartedAt: ctx.session.createdAt.getTime(),
    gitBranch: currentGitBranch(ctx.workspace),
    contextWindowTokens: ctx.settings.contextWindowTokens,
  });
}

export function refreshTodoFooter(ctx: CliContext): void {
  ctx.screen.setTodos(ctx.todoStore.list());
}

export async function refreshTaskFooter(ctx: CliContext): Promise<void> {
  ctx.screen.setTasks(await ctx.taskStore.list());
}

/** Wire an `InterjectFn` onto the agent's `pre_continue` hook. */
function registerInterject(agent: Agent, fn: InterjectFn): void {
  agent.on("pre_continue", async (ctx) => {
    const msgs = await fn(ctx);
    if (!msgs || msgs.length === 0) return undefined;
    return { messages: msgs };
  });
}

export function stopSpinner(ctx: CliContext): void {
  if (ctx.spinner) {
    ctx.spinner.stop();
    ctx.spinner = null;
  }
}

/**
 * Tool execution spinner: starts 300ms after a tool enters its execution
 * phase, stops on post_tool_use. The delay swallows the visual flash for fast
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
    await ctx.agent.persist();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    name: "rewind",
    description: "rewind history to a previous message (history after it is discarded)",
    argHint: "[<n>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleRewind(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "plan",
    description: "plan a task via a read-only plan sub-agent (no implementation)",
    argHint: "<task goal>",
    source: { kind: "builtin" },
    run: (_c, args) => handlePlan(args),
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
    name: "skills",
    description: "list discovered skills (SKILL.md)",
    source: { kind: "builtin" },
    run: () => {
      handleSkills(ctx);
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

  // Skills index: build one SkillsOptions and let getSkillList + builtinTools
  // both consume it. The first call warms the cache; the second hits it.
  const skillsOpts: SkillsOptions | undefined = settings.skills.enabled
    ? {
        cwd: workspace,
        ...(settings.skills.projectDirs ? { projectDirs: settings.skills.projectDirs } : {}),
        ...(settings.skills.userPaths ? { userPaths: settings.skills.userPaths } : {}),
        ...(settings.skills.extraDirs ? { extraDirs: settings.skills.extraDirs } : {}),
        maxResponseBytes: settings.skills.maxResponseBytes,
        logger,
      }
    : undefined;
  const skillItems = skillsOpts ? getSkillList(skillsOpts) : [];
  const skillsBlock = skillsOpts
    ? renderSkillsBlock(skillItems, settings.skills.maxIndexBytes)
    : "";
  if (skillsOpts) {
    await transcript.append({
      kind: "skills_loaded",
      data: { count: skillItems.length },
    });
    if (skillItems.length > 0) {
      logger.info({ count: skillItems.length }, "skills loaded");
    }
  }

  const todoStore = new TodoStore();
  const taskStore = new TaskStore(workspace, session.id);
  const longRunningManager = new LongRunningCommandManager();
  const tools = new ToolRegistry().registerAll(
    builtinTools(todoStore, skillsOpts, taskStore, longRunningManager),
  );
  const fileLedger = new InMemoryFileAccessLedger();
  const invariants = settings.invariants.enabled
    ? createInvariants({
        readBeforeEdit: settings.invariants.readBeforeEdit,
        mtimeCheck: settings.invariants.mtimeCheck,
      })
    : undefined;
  const rawDispatch = createDispatcher({
    registry: tools,
    logger,
    ...(invariants ? { invariants } : {}),
  });
  // Snapshot the prior content of any file a write/edit is about to mutate,
  // for /rewind. Capturing here in the dispatcher — rather than on the main
  // agent's pre_tool_use hook — means sub-agent tool calls, which reuse this
  // same `dispatch`, are captured too, under the current main turn's epoch.
  // Permission is gated by a pre_tool_use hook upstream of executeTool, so a
  // denied write never reaches here.
  const dispatch: ToolExecutor = async (use, toolCtx) => {
    if (use.name === "write" || use.name === "edit") {
      const raw = (use.input as { path?: unknown }).path;
      if (typeof raw === "string" && raw.length > 0) {
        await ctx.snapshots.capture(resolve(workspace, raw));
      }
    }
    return rawDispatch(use, toolCtx);
  };
  const registry = new SlashRegistry();

  // Forward the model's live token progress (uploaded prompt + estimated
  // output) into the active spinner. streamEvent fires per chunk, so throttle
  // to keep re-renders sane.
  let lastTokenPush = 0;
  const pushSpinnerTokens = (progress: {
    inputTokens?: number;
    outputTokens: number;
  }): void => {
    const now = Date.now();
    if (now - lastTokenPush < 80) return;
    lastTokenPush = now;
    screen.setSpinnerTokens(progress);
  };
  const buildModel = (id: string, trackTokens = true): ModelClient =>
    createAnthropicModel({
      apiKey,
      model: id,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(trackTokens ? { onStreamProgress: pushSpinnerTokens } : {}),
    });

  const ctx: CliContext = {
    session,
    logger,
    logPath,
    transcript,
    persistCursor: emptyCursor,
    resumed,
    snapshots: new SnapshotStore(join(session.dir, "snapshots")),
    settings,
    model: buildModel(settings.model),
    thinkingLevel: settings.thinking.level,
    thinkingBudgetOverride: settings.thinking.budgetTokens,
    spinner: null,
    toolSpinnerTimer: null,
    nextPlaceholder: "",
    pendingAutoCompactNotice: null,
    apiKey,
    workspace,
    memory,
    skillsBlock,
    version,
    noTranscript,
    noPretty,
    screen,
    todoStore,
    taskStore,
    longRunningManager,
    registry,
    tools,
    dispatch,
    fileLedger,
    permission: null as unknown as PermissionEngine,
    checkPermission: null as unknown as CliContext["checkPermission"],
    compactor: null as unknown as CliContext["compactor"],
    agent: null as unknown as Agent,
    buildLogger,
    buildModel,
  };

  // Permission ask bridges into the in-flight turn's signal so a long-pending
  // prompt gets cancelled when the user hits Esc. The agent owns the
  // controller; we just read its signal and tell the agent to abort on cancel.
  const askWithSignal: Screen["promptApproval"] = async (decision, input) => {
    const signal = ctx.agent.currentSignal();
    if (signal?.aborted) return "no";
    const promptOpts: Parameters<Screen["promptApproval"]>[2] = {};
    if (signal) {
      promptOpts.signal = signal;
      promptOpts.onCancel = () => ctx.agent.abort(new Error("interrupted by user"));
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

  const askUser: AskUserFn = async (req) => {
    clearToolSpinner(ctx);
    const signal = ctx.agent.currentSignal();
    return await ctx.screen.askUser(req, signal ? { signal } : undefined);
  };

  (ctx as { agent: Agent }).agent = createAgent({
    workspace,
    memory,
    skillsBlock,
    getSessionId: () => ctx.session.id,
    getMessagesPath: () => ctx.session.messagesPath,
    getTranscript: () => ctx.transcript,
    getLogger: () => ctx.logger,
    getPersistCursor: () => ctx.persistCursor,
    setPersistCursor: (c) => {
      ctx.persistCursor = c;
    },
    getModel: () => ctx.model,
    getThinkingBudget: () => currentThinkingBudget(ctx),
    getSettings: () => ({
      maxTokens: ctx.settings.maxTokens,
      maxTurns: ctx.settings.maxTurns,
      noTranscript: ctx.noTranscript,
      toolConcurrency: ctx.settings.toolConcurrency,
    }),
    getTools: () => ctx.tools.definitions(),
    dispatch: ctx.dispatch,
    checkPermission: ctx.checkPermission,
    compactor: ctx.compactor,
    fileLedger,
    askUser,
    getMessages: () => ctx.screen.getMessages(),
  });

  // Sub-agents: register createSubAgent into the same registry so the main
  // agent can spawn them. They reuse ctx.dispatch (parent tool impls) but see
  // the tool definitions minus createSubAgent — no recursion. Deps read ctx
  // lazily, so post-hoc registration is safe.
  if (settings.subagent.enabled) {
    // Sub-agents must NOT drive the parent's live spinner token counter. Several
    // run concurrently and each onStreamProgress callback reports that agent's
    // own running total (not a sum), so sharing the tracked model would make the
    // parent spinner's "↓ ~N tok" flicker between agents and read as garbage.
    // They therefore always run on a non-tracked model: a fixed one if
    // configured, otherwise the current main model mirrored with tracking off
    // (rebuilt when /model changes so the subagent follows the active model).
    const fixedSubagentModel = settings.subagent.model
      ? buildModel(settings.subagent.model, false)
      : null;
    let subagentFallback: { id: string; model: ModelClient } | null = null;
    const getSubagentModel = (): ModelClient => {
      if (fixedSubagentModel) return fixedSubagentModel;
      const id = ctx.settings.model;
      if (!subagentFallback || subagentFallback.id !== id) {
        subagentFallback = { id, model: buildModel(id, false) };
      }
      return subagentFallback.model;
    };
    ctx.tools.register(
      createSubAgentTool({
        workspace,
        memory,
        skillsBlock,
        getModel: getSubagentModel,
        getToolDefinitions: () => ctx.tools.definitions(),
        dispatch: (use, c) => ctx.dispatch(use, c),
        checkPermission: (tool, input) => ctx.checkPermission(tool, input),
        compactor: (messages) => ctx.compactor(messages),
        fileLedger,
        askUser,
        getLogger: () => ctx.logger,
        getLogDir: () => join(ctx.session.dir, "subagents"),
        getSettings: () => ({
          maxTokens: ctx.settings.subagent.maxTokens,
          maxTurns: ctx.settings.subagent.maxTurns,
          noTranscript: ctx.noTranscript,
          toolConcurrency: ctx.settings.toolConcurrency,
        }),
      }),
    );
  }

  registerUiHooks(ctx);
  registerInterject(ctx.agent, makeTodoReminder(todoStore));
  registerInterject(ctx.agent, makeTaskReminder(taskStore));
  ctx.agent.on("pre_request", makeLongRunningNotifier(longRunningManager));

  // /rewind: tag each user turn with the message index its prompt lands at —
  // the same point /rewind truncates to, and the epoch the dispatcher's
  // capture (see `dispatch` above) stamps onto each snapshot.
  ctx.agent.on("pre_user_prompt", () => {
    ctx.snapshots.setEpoch(ctx.screen.getMessages().length);
    return undefined;
  });
  void refreshTaskFooter(ctx);

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
    await ctx.snapshots.load();
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
