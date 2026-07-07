import { dirname, join, resolve } from "node:path";
import { createAgent, emptyCursor, loadMessages, type Agent } from "@nova/agent";
import { loadMemory, sliceFromLastCompacted } from "@nova/context";
import {
  createAnthropicModel,
  resolveProfile,
  type AskUserFn,
  type ModelClient,
  type ToolExecutor,
} from "@nova/core";
import { SlashRegistry } from "@nova/external";
import { LspManager, resolveServers } from "@nova/lsp";
import { Transcript } from "@nova/observability";
import {
  BackgroundCommandManager,
  TaskStore,
  TodoStore,
  makeBackgroundNotifier,
  makeTaskReminder,
  makeTodoReminder,
  type InterjectFn,
} from "@nova/tools";
import {
  createLogger,
  DEFAULT_CHEAP_TIER,
  loadProjectHooks,
  mergeHooks,
  resolveMaxTokens,
  resolveModelId,
  resolveModelModalities,
  resolveThinkingLevel,
  type Logger,
  type Settings,
} from "@nova/runtime";
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
import { dim } from "./colors.js";
import { buildCompactor } from "./compactor.js";
import { loadGoal } from "./goal.js";
import { buildMcpManager } from "./mcp.js";
import { canonicalizePath, canonicalizeRoots, PATH_INPUT_TOOLS } from "./path-safety.js";
import { MODE_COMMAND_TOOLS, resolveModeDecision, resolvePermissionRules } from "./permissions.js";
import { classifyCommandRisk } from "./auto-classify.js";
import { loadAgents } from "./agents.js";
import { loadPlugins } from "./plugins/loader.js";
import { DEFAULT_PLUGIN_CACHE_DIR } from "./plugins/install.js";
import { readCliVersion } from "./version.js";
import { UI_FRAME_MS } from "./ui/frame.js";
import { appendToolDetail, loadDisplaySidecar } from "./display-sidecar.js";
import { appendCard, appendCardsCleared, loadCards } from "./card-store.js";
import { registerUiHooks } from "./hooks.js";
import { restoreContextTokensFromTranscript, restoreUsageFromTranscript } from "./usage-restore.js";
import { UserHooks } from "./user-hooks.js";
import { SnapshotStore } from "./snapshots.js";
import { renderSkillsBlock } from "./skills-render.js";
import { loadFileCommandsInto, loadSkillCommandsInto } from "./slash.js";
import { loadSessionName } from "./session-name.js";
import { resolveSession } from "./session.js";
import { Screen, fatalExit } from "./screen.js";
import type { CliContext, CliRuntimeOptions } from "./ctx-types.js";
import {
  armToolSpinner,
  clearToolSpinner,
  currentThinkingBudget,
  INTERRUPT_HINT,
  persist,
  refreshBalance,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  stopSpinner,
  thinkingLevelLabel,
} from "./ctx-runtime.js";
import { registerBuiltinSlashCommands } from "./builtin-commands.js";

// Re-export the split-out types and ctx helpers so existing
// `import … from "./context.js"` call sites keep working unchanged after the
// split into ctx-types.ts / ctx-runtime.ts / builtin-commands.ts.
export type { CliContext, CliRuntimeOptions } from "./ctx-types.js";
export {
  armToolSpinner,
  clearToolSpinner,
  currentThinkingBudget,
  INTERRUPT_HINT,
  persist,
  refreshBalance,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  stopSpinner,
  thinkingLevelLabel,
};

/** Wire an `InterjectFn` onto the agent's `pre_continue` hook. */
function registerInterject(agent: Agent, fn: InterjectFn): void {
  agent.on("pre_continue", async (ctx) => {
    const msgs = await fn(ctx);
    if (!msgs || msgs.length === 0) return undefined;
    return { messages: msgs };
  });
}

/**
 * Wrap a model client so every request is sliced to the model-facing view —
 * from the last `<compacted>` boundary onward (see `sliceFromLastCompacted`).
 *
 * This is the one place the append-only full history (rendered by the TUI,
 * persisted verbatim to messages.jsonl) diverges from what the model receives:
 * compaction APPENDS a `<compacted>` boundary rather than truncating history,
 * and the model reads only the post-boundary slice. The transform is a pure
 * projection at the wire — the loop's canonical `messages` array is untouched,
 * so append-only persistence and full-history rendering both keep working.
 * Only the agent's model is wrapped; the summarizer's client stays raw.
 */
function withCompactionSlice(base: ModelClient): ModelClient {
  return {
    call: (req) => base.call({ ...req, messages: sliceFromLastCompacted(req.messages) }),
  };
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
    ...(settings.memory.auto.enabled
      ? {
          autoDir: resolve(workspace, settings.memory.auto.dir),
          autoMaxEntries: settings.memory.auto.maxEntries,
        }
      : {}),
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

  // Plugins: distributable bundles that package the existing extension types
  // (slash commands, sub-agents, skills, shell hooks, MCP servers). Loaded here,
  // before the extension points they feed, so skills fold into the (prefix-cached)
  // system prompt at session start and MCP specs reach buildMcpManager. Purely
  // declarative — nothing in a plugin is executed. Per-plugin failures are
  // isolated into `errors`, mirroring MCP connect.
  const pluginResult = settings.plugins.enabled
    ? await loadPlugins({
        cwd: workspace,
        projectDirs: settings.plugins.projectDirs,
        // Installed plugins live in the cache dir; scanned alongside user dirs.
        userDirs: [...settings.plugins.userDirs, DEFAULT_PLUGIN_CACHE_DIR],
        disabled: settings.plugins.disabled,
        logger,
      })
    : { plugins: [], errors: [] };
  for (const e of pluginResult.errors) {
    logger.warn({ dir: e.dir, err: e.message }, "plugin load failed");
  }
  if (pluginResult.plugins.length > 0) {
    logger.info(
      {
        count: pluginResult.plugins.length,
        names: pluginResult.plugins.map((p) => p.manifest.name),
      },
      "plugins loaded",
    );
  }
  // Skill directories contributed by plugins, folded into the index via extraDirs
  // (each entry is a `skills/` root whose subdirs each hold a SKILL.md).
  const pluginSkillRoots = [
    ...new Set(pluginResult.plugins.flatMap((p) => p.skills.map((s) => dirname(s)))),
  ];

  // Skills index: build one SkillsOptions and let getSkillList + builtinTools
  // both consume it. The first call warms the cache; the second hits it.
  const skillsExtraDirs = [...(settings.skills.extraDirs ?? []), ...pluginSkillRoots];
  const skillsOpts: SkillsOptions | undefined = settings.skills.enabled
    ? {
        cwd: workspace,
        ...(settings.skills.projectDirs ? { projectDirs: settings.skills.projectDirs } : {}),
        ...(settings.skills.userPaths ? { userPaths: settings.skills.userPaths } : {}),
        ...(skillsExtraDirs.length > 0 ? { extraDirs: skillsExtraDirs } : {}),
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
  // Plugin-contributed sub-agents. Layered after custom defs; built-ins and
  // earlier (project) definitions win on name collisions via addCustom.
  const pluginAgents = pluginResult.plugins.flatMap((p) => p.agents);
  if (pluginAgents.length > 0) {
    const skipped = agents.addCustom(pluginAgents);
    logger.info({ parsed: pluginAgents.length, skipped: skipped.length }, "plugin agents loaded");
  }

  const todoStore = new TodoStore();
  const taskStore = new TaskStore(workspace, session.id);
  const backgroundManager = new BackgroundCommandManager();
  // LSP code intelligence: one manager per session, rooted at the workspace.
  // Servers are started lazily on first `lsp` tool call and disposed at exit.
  const pluginLspServers = pluginResult.plugins.flatMap((p) => p.lspServers);
  const lspManager = settings.lsp.enabled
    ? new LspManager({
        root: workspace,
        servers: resolveServers([...(settings.lsp.servers ?? []), ...pluginLspServers]),
        initTimeoutMs: settings.lsp.initTimeoutMs,
        requestTimeoutMs: settings.lsp.requestTimeoutMs,
        diagnosticsTimeoutMs: settings.lsp.diagnosticsTimeoutMs,
        logger,
      })
    : undefined;
  // Plugin `bin/` dirs join PATH so their executables are on the shell path for
  // bash / runInBackground (and the sandbox, which wraps the same command).
  const pluginBinDirs = pluginResult.plugins.flatMap((p) => p.binDirs);
  if (pluginBinDirs.length > 0) {
    process.env.PATH = [...pluginBinDirs, process.env.PATH ?? ""].filter(Boolean).join(":");
  }
  const tools = new ToolRegistry().registerAll(
    builtinTools(todoStore, skillsOpts, taskStore, backgroundManager, lspManager),
  );

  // MCP: connect configured servers and bridge their tools into the registry
  // before the agent reads `tools.definitions()`. A server that fails to connect
  // is logged and skipped — it never blocks startup.
  const pluginMcpSpecs = Object.assign({}, ...pluginResult.plugins.map((p) => p.mcpServers));
  const mcp = buildMcpManager(settings, logger, pluginMcpSpecs);
  if (mcp) {
    await mcp.connectAll();
    for (const handler of mcp.handlers()) tools.register(handler);
    // Resources surface as two global, read-only model tools
    // (mcp_list_resources / mcp_read_resource); registered only when some
    // connected server advertised the capability. Prompts surface as slash
    // commands, registered later once the SlashRegistry exists (see finalize).
    for (const handler of mcp.resourceTools()) tools.register(handler);
    const failed = mcp.status().filter((s) => s.state === "failed");
    await transcript.append({
      kind: "mcp_loaded",
      data: {
        servers: mcp.serverCount,
        connected: mcp.connectedCount,
        tools: mcp.handlers().length,
        prompts: mcp.promptCommands().length,
        resources: mcp.resourceTools().length > 0,
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
  // runInBackground) — and the sub-agent calls that reuse this dispatch —
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
  // Transient model failures are retried inside the model adapter — DeepSeek's
  // 429/500/503 (carry a `status`) and malformed tool-call JSON (carries a
  // `reason`). Surface each retry in the live spinner (n/max) so a stalled turn
  // isn't a silent freeze.
  const onRetry = (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status?: number;
    reason?: string;
  }): void => {
    logger.warn(info, "model retry");
    retryHintShown = true;
    const secs = Math.round(info.delayMs / 100) / 10;
    const cause = info.status !== undefined ? String(info.status) : (info.reason ?? "error");
    screen.setSpinnerHint(`retry ${info.attempt}/${info.maxAttempts - 1} (${cause}, ${secs}s)`);
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
    if (!liveTimer) liveTimer = setTimeout(flushLive, UI_FRAME_MS);
  };
  const resetLiveStream = (): void => {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    liveBuf = { text: "", thinking: "" };
    screen.clearLiveDraft();
  };

  // `name` may be a bare model id or a key into settings.models; resolveModelId
  // maps a known alias to its concrete id and passes anything else through, so
  // both /model tiers and raw ids work. Resolving here means every caller —
  // ctx.model, predictModel, and the sub-agent model cache — gets alias support
  // for free, and the resolved id is what reaches cost/pricing matching.
  const buildModel = (name: string, trackTokens = true): ModelClient => {
    const model = resolveModelId(settings, name);
    return createAnthropicModel({
      apiKey,
      model,
      provider: resolveProfile(settings.provider, model),
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(trackTokens
        ? { onStreamProgress: pushSpinnerTokens, onStreamText: pushLiveText, onRetry }
        : {}),
    });
  };

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
    // Seed the active reasoning depth from the selected tier's per-tier
    // `thinking` level (the lite/pro/max ladder; DEFAULT_THINKING_LEVEL for
    // bare ids / tiers that omit it). A `--think` flag overrides it for this
    // run. /effort adjusts it in-session; a later /model switch re-seeds from
    // the new tier.
    thinkingLevel: cliOpts.thinkingLevelOverride ?? resolveThinkingLevel(settings, settings.model),
    thinkingBudgetOverride: cliOpts.thinkingBudgetOverride,
    goal: null,
    sessionName: null,
    spinner: null,
    toolSpinnerTimer: null,
    taskStartedAt: null,
    nextPlaceholder: "",
    pendingAutoCompactNotice: null,
    apiKey,
    workspace,
    memory,
    reloadMemory: null as unknown as CliContext["reloadMemory"],
    skillsBlock,
    version,
    noTranscript,
    noPretty,
    screen,
    resetLiveStream,
    todoStore,
    taskStore,
    backgroundManager,
    lspManager,
    sandbox: null as unknown as SandboxControl,
    setSandbox: null as unknown as CliContext["setSandbox"],
    userHooks: null as unknown as UserHooks,
    registry,
    tools,
    agents,
    mcp,
    plugins: pluginResult.plugins,
    dispatch,
    fileLedger,
    permission: null as unknown as PermissionEngine,
    checkPermission: null as unknown as CliContext["checkPermission"],
    compactor: null as unknown as CliContext["compactor"],
    agent: null as unknown as Agent,
    buildLogger,
    buildModel,
  };

  // Re-read memory from disk and swap in the fresh bundle. Only invoked at a
  // session boundary (switchToSession), where the prefix is already rebuilt, so
  // it never disturbs an in-session prefix cache. The agent reads the bundle via
  // `getMemory: () => ctx.memory`, so the next turn picks this up automatically.
  ctx.reloadMemory = async () => {
    ctx.memory = await loadMemory(workspace, memoryOpts);
    return ctx.memory;
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
  // The agent maintains its own auto-memory store under this directory; auto-allow
  // read/write/edit inside it so persisting a learned fact doesn't prompt. Resolve
  // to the same canonical form the gate compares paths in (the dir may not exist
  // yet — canonicalizePath folds that to the logical absolute path).
  const autoMemoryDir =
    memoryOpts.autoDir !== undefined
      ? await canonicalizePath(workspace, memoryOpts.autoDir)
      : undefined;
  const permission = new PermissionEngine({
    defaultEffect: settings.permissions.defaultEffect,
    rules: resolvePermissionRules(settings, allowedRoots, autoMemoryDir),
    ask: askWithSignal,
  });
  (ctx as { permission: PermissionEngine }).permission = permission;

  // OS command sandbox (opt-in). Confines subprocess writes to the same
  // allowedRoots the permission engine uses; network is unrestricted by default
  // unless the user sets `sandbox.network.allowedDomains`. createSandbox never
  // throws — on an unsupported platform / missing deps / disabled it returns an
  // inactive control and tools run unsandboxed. The bridge is read by the
  // dispatch closure above via the `sandboxBridge` variable.
  const sandboxControl = await createSandbox({
    enabled: settings.sandbox.enabled,
    writeRoots: allowedRoots,
    extraAllowWrite: settings.sandbox.filesystem.allowWrite,
    denyWrite: settings.sandbox.filesystem.denyWrite,
    denyRead: settings.sandbox.filesystem.denyRead,
    allowGitConfig: settings.sandbox.filesystem.allowGitConfig,
    monitorViolations: settings.sandbox.monitorViolations,
    network: settings.sandbox.network,
    logger,
  });
  (ctx as { sandbox: SandboxControl }).sandbox = sandboxControl;
  await transcript.append({
    kind: "sandbox_init",
    data: {
      active: sandboxControl.active,
      ...(sandboxControl.reason ? { reason: sandboxControl.reason } : {}),
    },
  });
  if (settings.sandbox.enabled && !sandboxControl.active) {
    logger.warn({ reason: sandboxControl.reason }, "sandbox requested but inactive");
  }

  // Runtime toggle for the `/sandbox` command. Captures allowedRoots/logger so
  // the rebuilt control confines writes to the same roots as the initial one.
  // The dispatch closure reads ctx.sandbox.bridge lazily, so reassigning here
  // flips sandboxing on the next subprocess tool. This toggle only mutates the
  // live control/settings; the `/sandbox` command persists the choice to
  // nova.config.json separately via saveSettings.
  (ctx as { setSandbox: CliContext["setSandbox"] }).setSandbox = async (enabled) => {
    await ctx.sandbox?.dispose();
    ctx.settings.sandbox.enabled = enabled;
    const next = await createSandbox({
      enabled,
      writeRoots: allowedRoots,
      extraAllowWrite: settings.sandbox.filesystem.allowWrite,
      denyWrite: settings.sandbox.filesystem.denyWrite,
      denyRead: settings.sandbox.filesystem.denyRead,
      allowGitConfig: settings.sandbox.filesystem.allowGitConfig,
      monitorViolations: settings.sandbox.monitorViolations,
      network: settings.sandbox.network,
      logger,
    });
    (ctx as { sandbox: SandboxControl }).sandbox = next;
    await transcript.append({
      kind: "sandbox_init",
      data: {
        active: next.active,
        ...(next.reason ? { reason: next.reason } : {}),
      },
    });
    return next;
  };

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
    // PreToolUse hooks run BEFORE the permission system (Claude Code semantics):
    // they see the raw tool input and can deny, allow (bypass mode + rules), or
    // ask (force a confirmation even when the gate would auto-allow). A "none"
    // verdict defers to the mode/engine logic below.
    const hookVerdict = await ctx.userHooks.evaluatePreToolUse(tool, input);
    if (hookVerdict.decision === "deny") {
      return { granted: false, reason: hookVerdict.reason };
    }
    if (hookVerdict.decision === "allow") {
      return { granted: true };
    }
    if (hookVerdict.decision === "ask") {
      const answer = await askWithSignal(
        { effect: "ask", reason: hookVerdict.reason ?? "PreToolUse hook requested confirmation" },
        { tool, input: evalInput },
      );
      return answer === "no"
        ? { granted: false, reason: "denied at PreToolUse hook prompt" }
        : { granted: true };
    }
    // Input-box permission mode (shift+tab cycles default/acceptEdits/auto/plan).
    // Applied AFTER canonicalization so accept-edits containment is judged on
    // the real on-disk path, and BEFORE the engine so plan-mode denial and
    // accept-edits auto-grant short-circuit the normal `ask` flow. A null
    // decision means "no mode opinion — defer to the engine rules below".
    const mode = ctx.screen.getPermissionMode();
    const modeDecision = resolveModeDecision(
      mode,
      tool,
      PATH_INPUT_TOOLS.has(tool) ? (evalInput.path as string) : undefined,
      allowedRoots,
    );
    if (modeDecision) return modeDecision;
    // `auto` mode runs commands unattended, but only after a risk classifier
    // clears them (static rules first, then an LLM call for the rest). A risky
    // verdict falls back to a confirmation prompt — Claude Code's auto-mode
    // fallback-to-prompting — rather than denying outright, so the user keeps
    // control while genuinely-safe commands run without interruption.
    if (mode === "auto" && MODE_COMMAND_TOOLS.has(tool)) {
      const command = typeof evalInput.command === "string" ? evalInput.command : "";
      const autoCfg = ctx.settings.permissions.autoMode;
      // Classifier model is independent of the agent's /model. Precedence:
      // explicit `autoMode.model` → the cheap built-in tier (when `models` still
      // carries it — a user override can replace it away) → the main model.
      // Defaulting to the cheap tier keeps safety checks fast and cheap;
      // buildModel resolves a bare id or `models` alias and is untracked, so the
      // classifier never pollutes the turn's token counters.
      const classifierModel =
        autoCfg.model ??
        (ctx.settings.models[DEFAULT_CHEAP_TIER] ? DEFAULT_CHEAP_TIER : ctx.settings.model);
      const verdict = await classifyCommandRisk(command, {
        model: autoCfg.llmClassifier ? ctx.buildModel(classifierModel, false) : undefined,
        timeoutMs: autoCfg.classifierTimeoutMs,
        signal: ctx.agent.currentSignal() ?? undefined,
      });
      if (verdict.risk === "safe") return { granted: true };
      const answer = await askWithSignal(
        {
          effect: "ask",
          reason: `Auto mode flagged this command as risky (${verdict.reason ?? verdict.source}). Approve to run it.`,
        },
        { tool, input: evalInput },
      );
      return answer === "no"
        ? { granted: false, reason: "denied at auto-mode risk prompt" }
        : { granted: true };
    }
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
    // Non-streaming client (trackTokens=false): the summarizer's output must
    // not leak into the live draft / spinner like a normal turn — it's internal
    // machinery, surfaced only via the post_compact card. Built from the live
    // model name so it still follows /model switches.
    getModel: () => ctx.buildModel(ctx.settings.model, false),
    onPreCompact: async ({ before }) => {
      const r = await ctx.userHooks.firePreCompact({
        subject: "auto",
        fields: { trigger: "auto", before },
      });
      if (r.blocked) {
        ctx.logger.warn({ reason: r.reason }, "auto-compaction blocked by PreCompact hook");
        ctx.screen.card(
          `auto-compaction blocked by PreCompact hook${r.reason ? `: ${r.reason}` : ""}`,
          { kind: "warn", title: "PreCompact" },
        );
      }
      return { block: r.blocked };
    },
    onAutoCompact: async ({ before, after }) => {
      ctx.pendingAutoCompactNotice = { before, after };
      ctx.logger.info({ before, after }, "auto-compacted");
      await ctx.userHooks.fire("PostCompact", {
        subject: "auto",
        fields: { trigger: "auto", before, after },
      });
    },
  });

  const askUser: AskUserFn = async (req) => {
    clearToolSpinner(ctx);
    const signal = ctx.agent.currentSignal();
    return await ctx.screen.askUser(req, signal ? { signal } : undefined);
  };

  (ctx as { agent: Agent }).agent = createAgent({
    workspace,
    getMemory: () => ctx.memory,
    skillsBlock,
    getSessionId: () => ctx.session.id,
    getMessagesPath: () => ctx.session.messagesPath,
    getTranscript: () => ctx.transcript,
    getLogger: () => ctx.logger,
    getPersistCursor: () => ctx.persistCursor,
    setPersistCursor: (c) => {
      ctx.persistCursor = c;
    },
    // Slice to the model-facing view at the wire (post-<compacted> boundary).
    // ctx.model may be rebuilt on /model switch, so wrap the live binding each
    // turn rather than capturing it once.
    getModel: () => withCompactionSlice(ctx.model),
    getThinkingBudget: () => currentThinkingBudget(ctx),
    getSettings: () => ({
      maxTokens: resolveMaxTokens(ctx.settings, ctx.settings.model),
      maxTurns: ctx.settings.maxTurns,
      maxTokensContinuations: ctx.settings.maxTokensContinuations,
      noTranscript: ctx.noTranscript,
      toolConcurrency: ctx.settings.toolConcurrency,
      modelModalities: resolveModelModalities(ctx.settings, ctx.settings.model),
      language: ctx.settings.language,
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
        getMemory: () => ctx.memory,
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
        // Fold the sub-agent's token spend into the parent session's cumulative
        // counters so the status line, `/usage`, and cost include it. Unlike the
        // parent's own `post_request` hook this does NOT touch `setContextTokens`
        // — the sub-agent's prompt is a separate context, not the main window's
        // fill level. Resume recovery reads the sub-agent transcripts too (see
        // restoreUsageFromTranscript), so this stays consistent after `--resume`.
        onUsage: (usage) => ctx.screen.addUsage(usage),
        getSettings: () => ({
          maxTokens: ctx.settings.subagent.maxTokens,
          maxTurns: ctx.settings.subagent.maxTurns,
          maxTokensContinuations: ctx.settings.maxTokensContinuations,
          noTranscript: ctx.noTranscript,
          toolConcurrency: ctx.settings.toolConcurrency,
          modelModalities: resolveModelModalities(ctx.settings, ctx.settings.model),
        }),
      }),
    );
  }

  registerUiHooks(ctx);
  registerInterject(ctx.agent, makeTodoReminder(todoStore));
  registerInterject(ctx.agent, makeTaskReminder(taskStore));
  ctx.agent.on("pre_request", makeBackgroundNotifier(backgroundManager));

  // Push completion: when a background command finishes while the agent is idle,
  // nudge the REPL to wake and react (the notifier above injects the output on
  // the resulting continuation turn). During a running turn we do nothing — the
  // notifier already delivers on that turn's next request. Headless has no input
  // loop to wake, so wake() is a no-op there.
  if (ctx.settings.background.autoContinueOnComplete) {
    backgroundManager.onComplete(() => {
      if (!ctx.agent.currentSignal()) ctx.screen.wake();
    });
  }

  // /rewind: tag each user turn with the message index its prompt lands at —
  // the same point /rewind truncates to, and the epoch the dispatcher's
  // capture (see `dispatch` above) stamps onto each snapshot.
  ctx.agent.on("pre_user_prompt", () => {
    ctx.snapshots.setEpoch(ctx.screen.getMessages().length);
    return undefined;
  });

  // User-configured shell hooks (settings.hooks). The four loop events are
  // registered LAST so the pre_user_prompt handler runs after the /rewind epoch
  // tag above — both are blocking, and a UserPromptSubmit hook that rewrites the
  // input would otherwise short-circuit the epoch tagging. The pre_tool_use /
  // post_tool_use handlers sit after the permission gate (in createAgent) and
  // the UI hooks for the same reason. Lifecycle events (SessionStart/End,
  // Pre/PostCompact) are fired directly via ctx.userHooks.fire(...).
  // Accumulate hooks across global config + project files (.nova/hooks.json,
  // .nova/hooks.local.json). Project hooks run shell commands when you open the
  // repo, so loaded files are surfaced loudly; a malformed file is reported and
  // skipped rather than aborting startup.
  const projectHooks = await loadProjectHooks(ctx.workspace);
  const pluginHooks = pluginResult.plugins
    .map((p) => p.hooks)
    .filter((h): h is NonNullable<typeof h> => h !== undefined);
  const mergedHooks = mergeHooks([
    ctx.settings.hooks,
    ...projectHooks.loaded.map((p) => p.hooks),
    ...pluginHooks,
  ]);
  if (projectHooks.loaded.length > 0) {
    const sources = projectHooks.loaded.map((p) => p.source);
    ctx.logger.info({ sources }, "loaded project hooks");
    ctx.screen.card(`shell hooks active from:\n${sources.join("\n")}`, {
      kind: "warn",
      title: "project hooks",
    });
  }
  for (const e of projectHooks.errors) {
    ctx.logger.warn({ source: e.source, err: e.message }, "project hooks file invalid");
    ctx.screen.card(`${e.source}\n${e.message}`, {
      kind: "error",
      title: "project hooks (ignored)",
    });
  }
  (ctx as { userHooks: UserHooks }).userHooks = new UserHooks({
    config: mergedHooks,
    cwd: ctx.workspace,
    getSignal: () => ctx.agent.currentSignal(),
    getSession: () => ({ id: ctx.session.id, transcriptPath: ctx.session.transcriptPath }),
    wrapCommand: (command, signal) => {
      const bridge = ctx.sandbox?.bridge;
      return bridge ? bridge.wrapCommand(command, signal) : Promise.resolve(command);
    },
    onError: (message) => ctx.logger.warn({ message }, "user hook failed"),
  });
  ctx.userHooks.register(ctx.agent.on);
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
  // Plugin slash commands (namespaced `<plugin>:<name>`). Registered after
  // builtins/file commands; a builtin of the same bare name still wins, and the
  // namespace keeps plugin commands from colliding with each other or user files.
  let pluginCmdCount = 0;
  for (const p of pluginResult.plugins) {
    for (const cmd of p.commands) {
      ctx.registry.register(cmd);
      pluginCmdCount++;
    }
  }
  if (pluginCmdCount > 0) {
    logger.info({ added: pluginCmdCount }, "plugin slash commands registered");
  }
  // Bridge MCP prompts as slash commands. Registered after builtins/file
  // commands; their namespaced (`mcp__server__prompt`) names won't collide.
  if (ctx.mcp) {
    const promptCommands = ctx.mcp.promptCommands();
    for (const cmd of promptCommands) ctx.registry.register(cmd);
    if (promptCommands.length > 0) {
      logger.info({ prompts: promptCommands.length }, "mcp prompt commands registered");
    }
  }
  // Bridge skills as slash commands. Registered last so an explicit builtin or
  // file command of the same name always shadows the auto-generated skill one.
  const skillCmds = loadSkillCommandsInto(ctx.registry, { cwd: workspace, settings, logger });
  if (skillCmds.added > 0) {
    logger.info({ added: skillCmds.added }, "skill slash commands registered");
  }

  // For resumed sessions, wipe whatever is already on screen (setup wizard
  // output, previous scrollback, etc.) so the loaded history shows cleanly.
  if (resumed) await ctx.screen.reset();

  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  refreshBanner(ctx);
  // Seed the session-name badge from disk (null for a fresh session).
  ctx.sessionName = await loadSessionName(session.id);
  ctx.screen.setSessionName(ctx.sessionName);
  logger.info(
    { sessionId: session.id, dir: session.dir, resumed },
    resumed ? "session resumed" : "session started",
  );
  if (memory.sources.length > 0) {
    logger.info({ sources: memory.sources }, "memory loaded");
  }

  // Persist inline cards so the timeline survives a resume / session switch.
  // The closure reads `ctx.session.dir` lazily so it follows session switches.
  // Wired here (after startup banners) so transient startup notices — project
  // hooks, the "loaded N" notice below — don't get recorded; live cards do.
  ctx.screen.setCardSink({
    append: (card) =>
      void appendCard(ctx.session.dir, card).catch((err) =>
        ctx.logger.warn({ err: String(err) }, "failed to persist card"),
      ),
    clear: () =>
      void appendCardsCleared(ctx.session.dir).catch((err) =>
        ctx.logger.warn({ err: String(err) }, "failed to persist card clear"),
      ),
  });

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
      const sidecar = await loadDisplaySidecar(session.dir);
      ctx.screen.setUserDisplayOverrides(sidecar.userOverrides);
      ctx.screen.setToolDetails(sidecar.toolDetails);
      // Restore persisted inline cards first, then push the ephemeral "loaded N"
      // notice (persist:false so it isn't re-recorded). Both happen before
      // setMessages so the notice's anchor (-1) puts it above the history.
      ctx.screen.setCards(await loadCards(session.dir));
      ctx.screen.card(dim(`loaded ${msgs.length} message(s) from disk`), { persist: false });
      ctx.screen.setMessages(msgs);
      // Restore an active /goal so auto-continuation survives a restart.
      ctx.goal = await loadGoal(session.dir);
      // Rebuild the session-cumulative token counters (cache hit rate / `/usage`)
      // from the transcript so they survive a restart.
      ctx.screen.seedUsage(
        await restoreUsageFromTranscript(session.transcriptPath, join(session.dir, "subagents")),
      );
      // Seed the context-window meter from the last request's total so it shows
      // real occupancy on launch, not 0% until the first model turn.
      ctx.screen.setContextTokens(await restoreContextTokensFromTranscript(session.transcriptPath));
      logger.info({ count: msgs.length }, "messages restored");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "failed to load messages");
      await fatalExit(ctx.screen, `failed to load messages: ${msg}`);
    }
  }

  return ctx;
}
