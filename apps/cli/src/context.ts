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
import { SlashRegistry, type McpManager } from "@nova/external";
import { LspManager, resolveServers } from "@nova/lsp";
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
import { createLogger, type Logger, type Session, type Settings } from "@nova/runtime";
import { PermissionDeniedError, PermissionEngine } from "@nova/safety";
import { createSandbox, type SandboxControl } from "@nova/sandbox";
import { AgentRegistry, createSubAgentTool } from "@nova/subagent";
import {
  InMemoryFileAccessLedger,
  ToolRegistry,
  builtinTools,
  createDispatcher,
  createInvariants,
  getSkillList,
  type SkillsOptions,
} from "@nova/tools";
import { ACCENT_RGB, accent, dim } from "./colors.js";
import { buildCompactor } from "./compactor.js";
import { buildMcpManager } from "./mcp.js";
import { canonicalizePath, canonicalizeRoots, PATH_INPUT_TOOLS } from "./path-safety.js";
import { resolveModeDecision, resolvePermissionRules } from "./permissions.js";
import { loadAgents } from "./agents.js";
import {
  handleClear,
  handleCommands,
  handleCommit,
  handleCompact,
  handleDiff,
  handleHelp,
  handleInit,
  handleLsp,
  handleMcp,
  handlePlan,
  handlePredict,
  handleAgent,
  handleAgents,
  handleResume,
  handleReview,
  handleRewind,
  handleSkills,
  handleEffort,
} from "./commands/index.js";
import { TOOL_SPINNER_DELAY_MS, WORKING_WORDS } from "./constants.js";
import { appendToolDetail, loadDisplaySidecar } from "./display-sidecar.js";
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

  // ===== Mutable: changes on /effort, /predict =====
  settings: Settings;
  model: ModelClient;
  /**
   * Non-tracked mirror of `model` used by next-input prediction. Predict is a
   * silent background call; it must NOT carry the live-stream / spinner-token
   * callbacks (`onStreamText` et al.), or its predicted task text leaks into the
   * message feed as a phantom assistant draft. Same reasoning as sub-agents
   * (see the `buildModel(id, false)` usage below).
   */
  predictModel: ModelClient;
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
  /**
   * Drop the in-flight streaming draft AND cancel any pending throttled flush,
   * so a late timer can't resurrect a draft the final message already replaced.
   * Called at each turn handoff (post_messages) and on request error/abort.
   */
  readonly resetLiveStream: () => void;
  readonly todoStore: TodoStore;
  readonly taskStore: TaskStore;
  readonly longRunningManager: LongRunningCommandManager;
  /** LSP code-intelligence manager. Undefined when settings.lsp.enabled is false. */
  readonly lspManager: LspManager | undefined;
  /** OS command sandbox handle. Inactive (bridge undefined) unless opted in via settings.sandbox. */
  readonly sandbox: SandboxControl;
  readonly registry: SlashRegistry;
  readonly tools: ToolRegistry;
  /**
   * Available sub-agent definitions (built-ins + custom defs loaded from
   * .nova/agents / .claude/agents). Seeded with built-ins even when sub-agents
   * are disabled; `/agents` lists it and `/agents reload` refreshes it in place.
   */
  readonly agents: AgentRegistry;
  /** Connected MCP servers (tools already bridged into `tools`), or null when disabled/none. */
  readonly mcp: McpManager | null;
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
  readonly buildModel: (id: string, trackTokens?: boolean) => ModelClient;
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
    contextWindowTokens: ctx.settings.contextWindowTokens,
    thinkingLabel: thinkingLevelLabel(ctx),
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

/** Default spinner hint shown while a turn / tool is running. */
export const INTERRUPT_HINT = "esc to interrupt";

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
      { words: WORKING_WORDS, tint: ACCENT_RGB, colorize: accent },
      INTERRUPT_HINT,
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
    name: "effort",
    description: "show or change the extended-thinking level",
    argHint: "[<level>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleEffort(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "clear",
    description: "start a fresh session (the current one stays resumable)",
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
    name: "init",
    description: "generate or refresh NOVA.md by analyzing the codebase",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleInit(args),
  });
  ctx.registry.register({
    name: "plan",
    description: "plan a task via a read-only plan sub-agent (no implementation)",
    argHint: "<task goal>",
    source: { kind: "builtin" },
    run: (_c, args) => handlePlan(args),
  });
  ctx.registry.register({
    name: "commit",
    description: "review pending changes and create a git commit",
    argHint: "[guidance…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleCommit(args),
  });
  ctx.registry.register({
    name: "diff",
    description: "browse uncommitted changes in a modal: file list → per-file diff",
    argHint: "[pathspec]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleDiff(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "review",
    description: "review the current uncommitted diff (read-only)",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleReview(args),
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
    name: "agents",
    description: "list available sub-agent types; `reload` to rescan agent files",
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleAgents(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "agent",
    description: "delegate a task to a named sub-agent",
    argHint: "<name> <task>",
    source: { kind: "builtin" },
    run: (_c, args) => handleAgent(ctx, args),
  });
  ctx.registry.register({
    name: "mcp",
    description: "show MCP server status; `tools` to list bridged tools",
    argHint: "[tools]",
    source: { kind: "builtin" },
    run: (_c, args) => {
      handleMcp(ctx, args);
      return handled;
    },
  });
  ctx.registry.register({
    name: "lsp",
    description: "show configured language servers and their status",
    source: { kind: "builtin" },
    run: () => {
      handleLsp(ctx);
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

  // Sub-agent definitions: built-ins (general-purpose / explore / plan) are
  // always seeded; custom defs from .nova/agents / .claude/agents are layered
  // on when sub-agents are enabled. Built-ins win on name collisions. The
  // createSubAgent tool and /agents both read this registry; /agents reload
  // refreshes it in place.
  const agents = new AgentRegistry();
  if (settings.subagent.enabled) {
    const { defs, errors } = loadAgents(settings, workspace, logger);
    const skipped = agents.addCustom(defs);
    await transcript.append({
      kind: "agents_loaded",
      data: { parsed: defs.length, skipped, errors: errors.length },
    });
    if (defs.length > 0 || errors.length > 0) {
      logger.info(
        { parsed: defs.length, skipped: skipped.length, errors: errors.length },
        "custom agents loaded",
      );
    }
  }

  const todoStore = new TodoStore();
  const taskStore = new TaskStore(workspace, session.id);
  const longRunningManager = new LongRunningCommandManager();
  // LSP code intelligence: one manager per session, rooted at the workspace.
  // Servers are started lazily on first `lsp` tool call and disposed at exit.
  const lspManager = settings.lsp.enabled
    ? new LspManager({
        root: workspace,
        servers: resolveServers(settings.lsp.servers),
        initTimeoutMs: settings.lsp.initTimeoutMs,
        requestTimeoutMs: settings.lsp.requestTimeoutMs,
        diagnosticsTimeoutMs: settings.lsp.diagnosticsTimeoutMs,
        logger,
      })
    : undefined;
  const tools = new ToolRegistry().registerAll(
    builtinTools(todoStore, skillsOpts, taskStore, longRunningManager, lspManager),
  );

  // MCP: connect configured servers and bridge their tools into the registry
  // before the agent reads `tools.definitions()`. A server that fails to connect
  // is logged and skipped — it never blocks startup.
  const mcp = buildMcpManager(settings, logger);
  if (mcp) {
    await mcp.connectAll();
    for (const handler of mcp.handlers()) tools.register(handler);
    const failed = mcp.status().filter((s) => s.state === "failed");
    await transcript.append({
      kind: "mcp_loaded",
      data: {
        servers: mcp.serverCount,
        connected: mcp.connectedCount,
        tools: mcp.handlers().length,
        failed: failed.map((s) => s.name),
      },
    });
    if (mcp.connectedCount > 0) {
      logger.info(
        { connected: mcp.connectedCount, tools: mcp.handlers().length },
        "mcp servers connected",
      );
    }
    if (failed.length > 0) {
      logger.warn({ failed: failed.map((s) => s.name) }, "mcp servers failed to connect");
    }
  }

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
  // denied write never reaches here. This is also where the OS sandbox bridge
  // is threaded onto the ToolContext, so subprocess tools (bash,
  // runLongRunningCommand) — and the sub-agent calls that reuse this dispatch —
  // wrap their commands before spawning.
  const dispatch: ToolExecutor = async (use, toolCtx) => {
    if (use.name === "write" || use.name === "edit") {
      const raw = (use.input as { path?: unknown }).path;
      if (typeof raw === "string" && raw.length > 0) {
        await ctx.snapshots.capture(resolve(workspace, raw));
      }
    }
    // ctx.sandbox is assigned after allowedRoots below; its bridge is undefined
    // when sandboxing is inactive. Read lazily — dispatch only runs during a
    // turn, long after ctx.sandbox is set.
    const bridge = ctx.sandbox?.bridge;
    const execCtx = bridge ? { ...toolCtx, sandbox: bridge } : toolCtx;
    return rawDispatch(use, execCtx);
  };
  const registry = new SlashRegistry();

  // Forward the model's live token progress (uploaded prompt + estimated
  // output) into the active spinner. streamEvent fires per chunk, so throttle
  // to keep re-renders sane.
  let lastTokenPush = 0;
  // True while a DeepSeek retry hint is parked on the spinner. Cleared once the
  // retried request actually starts streaming output again (see below).
  let retryHintShown = false;
  const pushSpinnerTokens = (progress: { inputTokens?: number; outputTokens: number }): void => {
    // Output flowing again means we're past the retry backoff — restore the
    // default interrupt hint so a stale "retry n/max" doesn't linger on the
    // (now succeeding) request.
    if (retryHintShown && progress.outputTokens > 0) {
      retryHintShown = false;
      screen.setSpinnerHint(INTERRUPT_HINT);
    }
    const now = Date.now();
    if (now - lastTokenPush < 80) return;
    lastTokenPush = now;
    screen.setSpinnerTokens(progress);
  };
  // DeepSeek's transient errors (429/500/503) are retried inside the model
  // adapter; surface each retry in the live spinner (n/max) so a stalled turn
  // isn't a silent freeze.
  const onRetry = (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status: number;
  }): void => {
    logger.warn(info, "deepseek retry");
    retryHintShown = true;
    const secs = Math.round(info.delayMs / 100) / 10;
    screen.setSpinnerHint(
      `retry ${info.attempt}/${info.maxAttempts - 1} (${info.status}, ${secs}s)`,
    );
  };

  // Stream assistant text/thinking into the live draft. Deltas arrive token by
  // token; batch them on a ~50ms timer (one store write per frame, no dropped
  // text) so a fast stream doesn't thrash Ink. `resetLiveStream` cancels the
  // timer and drops the buffer so a late flush can't resurrect a cleared draft.
  let liveBuf: { text: string; thinking: string } = { text: "", thinking: "" };
  let liveTimer: NodeJS.Timeout | null = null;
  const flushLive = (): void => {
    liveTimer = null;
    if (!liveBuf.text && !liveBuf.thinking) return;
    screen.appendLiveDraft(liveBuf);
    liveBuf = { text: "", thinking: "" };
  };
  const pushLiveText = (delta: { text?: string; thinking?: string }): void => {
    // Honors the stream toggle (settings.stream.enabled). When off, deltas are
    // dropped and the TUI reveals the answer only when the final message lands.
    if (!settings.stream.enabled) return;
    if (delta.text) liveBuf.text += delta.text;
    if (delta.thinking) liveBuf.thinking += delta.thinking;
    if (!liveTimer) liveTimer = setTimeout(flushLive, 50);
  };
  const resetLiveStream = (): void => {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    liveBuf = { text: "", thinking: "" };
    screen.clearLiveDraft();
  };

  const buildModel = (id: string, trackTokens = true): ModelClient =>
    createAnthropicModel({
      apiKey,
      model: id,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(trackTokens
        ? { onStreamProgress: pushSpinnerTokens, onStreamText: pushLiveText, onRetry }
        : {}),
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
    predictModel: buildModel(settings.model, false),
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
    resetLiveStream,
    todoStore,
    taskStore,
    longRunningManager,
    lspManager,
    sandbox: null as unknown as SandboxControl,
    registry,
    tools,
    agents,
    mcp,
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

  // The workspace cwd is always an allowed root; users widen the set via
  // permissions.additionalDirectories. Canonicalized once here so the engine's
  // `within` matcher compares real on-disk paths (a symlinked cwd still matches).
  const allowedRoots = await canonicalizeRoots(
    [workspace, ...settings.permissions.additionalDirectories],
    workspace,
  );
  const permission = new PermissionEngine({
    defaultEffect: settings.permissions.defaultEffect,
    rules: resolvePermissionRules(settings, allowedRoots),
    ask: askWithSignal,
  });
  (ctx as { permission: PermissionEngine }).permission = permission;

  // OS command sandbox (opt-in). Confines subprocess writes to the same
  // allowedRoots the permission engine uses; network stays open. createSandbox
  // never throws — on an unsupported platform / missing deps / disabled it
  // returns an inactive control and tools run unsandboxed. The bridge is read
  // by the dispatch closure above via the `sandboxBridge` variable.
  const sandboxControl = await createSandbox({
    enabled: settings.sandbox.enabled,
    writeRoots: allowedRoots,
    extraAllowWrite: settings.sandbox.filesystem.allowWrite,
    denyWrite: settings.sandbox.filesystem.denyWrite,
    denyRead: settings.sandbox.filesystem.denyRead,
    allowGitConfig: settings.sandbox.filesystem.allowGitConfig,
    monitorViolations: settings.sandbox.monitorViolations,
    logger,
  });
  (ctx as { sandbox: SandboxControl }).sandbox = sandboxControl;
  await transcript.append({
    kind: "sandbox_init",
    data: { active: sandboxControl.active, ...(sandboxControl.reason ? { reason: sandboxControl.reason } : {}) },
  });
  if (settings.sandbox.enabled && !sandboxControl.active) {
    logger.warn({ reason: sandboxControl.reason }, "sandbox requested but inactive");
  }

  (ctx as { checkPermission: CliContext["checkPermission"] }).checkPermission = async (
    tool,
    input,
  ) => {
    // Canonicalize path-bearing inputs (resolve + realpath) BEFORE the engine
    // sees them, so the decision is made on the file actually touched — not the
    // raw string. This closes `..` traversal and symlink escape, and makes both
    // workspace and user-defined rules match canonical absolute paths. We never
    // mutate the caller's input (the tool still runs on its own copy); the
    // canonical path is used for evaluation only.
    let evalInput = input as Record<string, unknown>;
    if (PATH_INPUT_TOOLS.has(tool)) {
      const raw = evalInput.path;
      // glob/grep treat an absent/empty `path` as the cwd; gate against the
      // canonical workspace root in that case so the `within` rule allows it
      // (a path-less glob/grep is the common in-workspace search) instead of
      // missing on `undefined` and falling through to ask.
      const target = typeof raw === "string" && raw.length > 0 ? raw : ".";
      evalInput = { ...evalInput, path: await canonicalizePath(workspace, target) };
    }
    // Input-box permission mode (shift+tab cycles default/acceptEdits/plan).
    // Applied AFTER canonicalization so accept-edits containment is judged on
    // the real on-disk path, and BEFORE the engine so plan-mode denial and
    // accept-edits auto-grant short-circuit the normal `ask` flow. A null
    // decision means "no mode opinion — defer to the engine rules below".
    const modeDecision = resolveModeDecision(
      ctx.screen.getPermissionMode(),
      tool,
      PATH_INPUT_TOOLS.has(tool) ? (evalInput.path as string) : undefined,
      allowedRoots,
    );
    if (modeDecision) return modeDecision;
    try {
      await permission.check({ tool, input: evalInput });
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
    // They therefore always run on a non-tracked model, cached per model-id.
    //
    // Model precedence: the definition's `model` override → settings.subagent.model
    // (global sub-agent default) → the active main model (so sub-agents follow
    // /model changes when nothing more specific is set).
    const subagentModelCache = new Map<string, ModelClient>();
    const getSubagentModel = (modelId?: string): ModelClient => {
      const id = modelId ?? settings.subagent.model ?? ctx.settings.model;
      let model = subagentModelCache.get(id);
      if (!model) {
        model = buildModel(id, false);
        subagentModelCache.set(id, model);
      }
      return model;
    };
    ctx.tools.register(
      createSubAgentTool({
        workspace,
        memory,
        skillsBlock,
        getAgentRegistry: () => ctx.agents,
        getModel: getSubagentModel,
        getToolDefinitions: () => ctx.tools.definitions(),
        dispatch: (use, c) => ctx.dispatch(use, c),
        checkPermission: (tool, input) => ctx.checkPermission(tool, input),
        compactor: (messages) => ctx.compactor(messages),
        fileLedger,
        askUser,
        getLogger: () => ctx.logger,
        getLogDir: () => join(ctx.session.dir, "subagents"),
        // Live progress: update the UI on every tick; persist the snapshot to
        // the display sidecar once the sub-agent finishes so it survives resume
        // (the canonical message only keeps the final report).
        onDetail: (toolUseId, entries, done) => {
          ctx.screen.setToolDetail(toolUseId, entries);
          if (done) {
            void appendToolDetail(ctx.session.dir, toolUseId, entries).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.logger.warn({ err: msg }, "failed to persist sub-agent details");
            });
          }
        },
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
      const sidecar = await loadDisplaySidecar(session.dir);
      ctx.screen.setUserDisplayOverrides(sidecar.userOverrides);
      ctx.screen.setToolDetails(sidecar.toolDetails);
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
