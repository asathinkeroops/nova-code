import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentRegistry,
  assembleSession,
  buildCompactor,
  emptyCursor,
  fixedOverheadTotal,
  loadMemory,
  loadMessages,
  SUBAGENT_PROMPT,
} from "@nova/agent";
import {
  userText,
  type Agent,
  type AskUserFn,
  type ModelClient,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutor,
  type ToolPromptSection,
  type ToolUseBlock,
} from "@nova/core";
import { createModel, resolveProfile } from "@nova/model";
import { SlashRegistry } from "./slash-registry.js";
import { LspManager, resolveServers } from "@nova/lsp";
import {
  BackgroundCommandManager,
  TaskStore,
  TodoStore,
  makeBackgroundNotifier,
  makeMonitorNotifier,
  MonitorManager,
  makeTaskReminder,
  makeTodoReminder,
  WORKTREE_TOOL_NAMES,
  type InterjectFn,
} from "@nova/tools";
import {
  activeModels,
  activeProvider,
  activeProviderHeaders,
  activeProviderProfile,
  activeProviderRequestParams,
  API_KEY_ENV,
  createLogger,
  DEFAULT_CHEAP_TIER,
  loadProjectHooks,
  mergeHooks,
  resolveAutoMemoryDir,
  resolveContextWindowSize,
  resolveMaxTokens,
  resolveModelId,
  resolveSkillsIndexBudget,
  resolveModelModalities,
  resolveApiKey,
  resolveThinkingLevel,
  Transcript,
  writeSessionWorkspace,
  type Logger,
  type Settings,
} from "@nova/base";
import {
  createInvariants,
  createSandbox,
  InMemoryFileAccessLedger,
  PermissionDeniedError,
  PermissionEngine,
  type SandboxControl,
} from "@nova/safety";
import {
  BUILTIN_TOOL_PROMPTS,
  CronStore,
  ToolRegistry,
  builtinTools,
  createDispatcher,
  createPlanModeTools,
  getSkillList,
  PLAN_MODE_TOOL_NAMES,
  renderToolPrompts,
  staticSection,
  type SkillsOptions,
} from "@nova/tools";
import { CronScheduler } from "./cron-scheduler.js";
import { dim } from "./colors.js";
import { measureCtxOverhead } from "./context-usage.js";
import { loadGoal } from "./goal.js";
import { buildMcpManager } from "./mcp.js";
import {
  canonicalizeGateInput,
  canonicalizePath,
  canonicalizeRoots,
  PATH_INPUT_TOOLS,
} from "./path-safety.js";
import { AUTO_READ_TOOLS, isAutoAllowedReadPath } from "./read-policy.js";
import {
  applyToolDenylist,
  MODE_COMMAND_TOOLS,
  resolveModeDecision,
  resolvePermissionRules,
} from "./permissions.js";
import { classifyCommandRisk } from "./auto-classify.js";
import { makePlanModeReminder } from "./plan-mode-reminder.js";
import { askPlanApproval, shouldStopTurn } from "./plan-approval.js";
import { loadAgents } from "./agents.js";
import { loadPlugins, pluginSkillRoots } from "./plugins/loader.js";
import { DEFAULT_PLUGIN_CACHE_DIR } from "./plugins/install.js";
import { buildGuideAgentDefinition, NOVA_GUIDE_AGENT } from "./guide/agent.js";
import { ensureFresh, resolveGuideSourceDir } from "./guide/provisioner.js";
import { readCliVersion } from "./version.js";
import { UI_FRAME_MS } from "./ui/frame.js";
import { createOutputRateTracker } from "./output-rate.js";
import { appendToolDetail, loadDisplaySidecar } from "./display-sidecar.js";
import { appendCard, appendCardsCleared, loadCards } from "./card-store.js";
import { registerUiHooks } from "./hooks.js";
import { restoreFromTranscript } from "./usage-restore.js";
import { UserHooks } from "./user-hooks.js";
import { SnapshotStore } from "./snapshots.js";
import {
  repoIdentity,
  sandboxGitAllowWrite,
  worktreeBinding,
  type WorktreeBinding,
} from "./worktree.js";
import { worktreeIsolationDenial } from "./worktree-guard.js";
import { registerWorktreeTools } from "./worktree-tools.js";
import { renderSkillsBlock } from "./skills-render.js";
import { loadFileCommandsInto, loadSkillCommandsInto } from "./slash.js";
import { loadSessionName } from "./session-name.js";
import { resolveSession, type ResolvedSession } from "./session.js";
import { Screen, fatalExit } from "./screen.js";
import type { CliContext, CliRuntimeOptions } from "./ctx-types.js";
import {
  persist,
  refreshBalance,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  scheduleTaskAutoClear,
  scheduleTodoAutoClear,
  startWorkingSpinner,
  stopSpinner,
  thinkingLevelLabel,
} from "./ctx-runtime.js";
import { registerBuiltinSlashCommands } from "./builtin-commands.js";
import { t } from "./i18n/index.js";

// Re-export the split-out types and ctx helpers so existing
// `import … from "./context.js"` call sites keep working unchanged after the
// split into ctx-types.ts / ctx-runtime.ts / builtin-commands.ts.
export type { CliContext, CliRuntimeOptions } from "./ctx-types.js";
export {
  persist,
  refreshBalance,
  refreshBanner,
  refreshTaskFooter,
  refreshTodoFooter,
  scheduleTaskAutoClear,
  scheduleTodoAutoClear,
  startWorkingSpinner,
  stopSpinner,
  thinkingLevelLabel,
};

/**
 * Built-in per-agent model defaults, keyed by sub-agent name. These are the
 * shipped tiers each built-in runs on when the user hasn't overridden it via
 * `settings.subagent.model[name]`. Single source of truth — the agent
 * definitions themselves carry no `model` pin. Values are tier keys resolved by
 * `buildModel`; all three (pro/max) are REQUIRED_MODEL_TIERS rungs, so they
 * always resolve. `general-purpose`/`plan` want the deepest reasoning; the
 * read-only retrieval/guide agents run on the capable-but-cheaper `pro`.
 */
const DEFAULT_SUBAGENT_MODELS: Record<string, string> = {
  "general-purpose": "max",
  explore: "pro",
  plan: "max",
  [NOVA_GUIDE_AGENT]: "pro",
};

/** Wire an `InterjectFn` onto the agent's `pre_continue` hook. */
function registerInterject(agent: Agent, fn: InterjectFn): void {
  agent.on("pre_continue", async (ctx) => {
    const msgs = await fn(ctx);
    if (!msgs || msgs.length === 0) return undefined;
    return { messages: msgs };
  });
}

export async function createContext(
  settings: Settings,
  screen: Screen,
  cliOpts: CliRuntimeOptions,
  /**
   * The session + checkout the host already resolved (and trust-checked). When
   * omitted — tests, or a host that has not split the startup order — this
   * resolves it here, as every caller used to.
   */
  target?: ResolvedSession,
): Promise<CliContext> {
  const provider = activeProvider(settings);
  if (!provider) {
    throw new Error("currentProvider does not name a configured provider");
  }
  const apiKey = resolveApiKey(settings);
  if (!apiKey) {
    throw new Error(`active provider apiKey is not set (nor in $${API_KEY_ENV})`);
  }

  // Resolve the session FIRST: resuming one that ended inside a linked worktree
  // re-enters that checkout, so the workspace below may come from the session
  // rather than from the launch directory (see resolveSession).
  const {
    session,
    resumed,
    workspace: resolvedWorkspace,
  } = target ?? (await resolveSession(cliOpts, settings.sessionDir, cliOpts.cwd ?? process.cwd()));
  const workspace = resolvedWorkspace;
  const noPretty = cliOpts.noPretty ?? false;
  const noTranscript = cliOpts.noTranscript ?? false;
  // Which checkout this is, if any. Worktrees are re-detected on every switch
  // (`setWorkspace`), so this is the startup snapshot only.
  let worktree: WorktreeBinding | undefined = await worktreeBinding(workspace);
  const memoryRoot = worktree?.main ?? workspace;

  /**
   * Memory options for a checkout. The auto-memory store is keyed by the
   * REPOSITORY, not the worktree: every checkout of a repo shares one learned
   * store, the same way it shares a history. `memory.auto.dir` is documented as
   * workspace-relative, so an explicit override still resolves against the
   * checkout actually in use.
   */
  const autoDirFor = (ws: string, repoMain: string | undefined): string | undefined =>
    settings.memory.auto.enabled
      ? settings.memory.auto.dir
        ? resolve(ws, settings.memory.auto.dir)
        : resolveAutoMemoryDir(repoMain ?? ws)
      : undefined;
  const memoryOptsFor = (ws: string, repoMain: string | undefined) => ({
    filenames: settings.memory.filenames,
    ...(settings.memory.userPaths ? { userPaths: settings.memory.userPaths } : {}),
    ...(settings.memory.globalPath ? { globalPath: settings.memory.globalPath } : {}),
    ...(settings.memory.auto.enabled
      ? {
          autoDir: autoDirFor(ws, repoMain),
          autoMaxEntries: settings.memory.auto.maxEntries,
        }
      : {}),
  });
  const memoryOpts = memoryOptsFor(workspace, memoryRoot);
  const memory = await loadMemory(workspace, memoryOpts);
  const version = await readCliVersion();

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
  const pluginSkills = pluginSkillRoots(pluginResult.plugins);

  // Skills index: build one SkillsOptions and let getSkillList + builtinTools
  // both consume it. The first call warms the cache; the second hits it.
  const skillsExtraDirs = [...(settings.skills.extraDirs ?? []), ...pluginSkills.dirs];
  const skillsOpts: SkillsOptions | undefined = settings.skills.enabled
    ? {
        cwd: workspace,
        ...(settings.skills.projectDirs ? { projectDirs: settings.skills.projectDirs } : {}),
        ...(settings.skills.userPaths ? { userPaths: settings.skills.userPaths } : {}),
        ...(skillsExtraDirs.length > 0 ? { extraDirs: skillsExtraDirs } : {}),
        ...(pluginSkills.dirs.length > 0 ? { pluginRoots: pluginSkills.roots } : {}),
        maxResponseBytes: settings.skills.maxResponseBytes,
        maxFileBytes: settings.skills.maxFileBytes,
        disableShellExecution: settings.skills.disableShellExecution,
        logger,
      }
    : undefined;
  const skillItems = skillsOpts ? getSkillList(skillsOpts) : [];
  // Skills flagged `disable-model-invocation` are withheld from the model-facing
  // block so the model won't auto-invoke them; they remain reachable via their
  // `/{name}` slash command (which names the skill explicitly to loadSkill).
  const modelSkillItems = skillItems.filter((s) => !s.disableModelInvocation);
  const skillsBlock = skillsOpts
    ? renderSkillsBlock(modelSkillItems, {
        budgetBytes: resolveSkillsIndexBudget(settings, settings.model),
        maxDescriptionBytes: settings.skills.maxDescriptionBytes,
      })
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

  // Every system-prompt section that is tied to a tool, in one list: the
  // builtins' own, `createSubAgent`'s (owned by @nova/agent), and the skills
  // index — which only the host can build, since its byte budget comes from
  // settings and the active model. The list is inert until rendered against the
  // final registry; see `ctx.toolsGuidance`.
  const toolPromptSections: ToolPromptSection[] = [
    ...BUILTIN_TOOL_PROMPTS,
    SUBAGENT_PROMPT,
    // Ordered last so the index sits after the guidance bullets that explain
    // what to do with it. Gated on loadSkill so `permissions.deny` removing the
    // tool also removes the index it advertises.
    staticSection({ id: "skills", order: 200, requires: ["loadSkill"], text: skillsBlock }),
  ];
  const renderToolsGuidance = (tools: ToolDefinition[]): string =>
    renderToolPrompts(tools, toolPromptSections).text;

  // Sub-agent definitions: built-ins (general-purpose / explore / plan) are
  // always seeded; custom defs from .nova/agents / .claude/agents are layered
  // on when sub-agents are enabled. Built-ins win on name collisions. The
  // createSubAgent tool and /agents both read this registry; /agents reload
  // refreshes it in place.
  // Nova Code Guide source: the read-only guide sub-agent answers from this
  // directory — a remote clone (source: "remote", materialized on first
  // /nova-code-guide) or a local dir (source: "local"). Resolved once here so
  // both the agent definition (which bakes the path into its guidance) and the
  // permission roots below agree on the same directory.
  const guideDir =
    settings.guide.enabled && settings.subagent.enabled
      ? resolveGuideSourceDir(settings.guide, workspace)
      : undefined;

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
  // Register the built-in Nova Code Guide sub-agent, scoped to the local Nova
  // checkout. Added last (users can't shadow it — the name is reserved) and only
  // when the guide is enabled and sub-agents are on (it runs as a sub-agent).
  if (guideDir) {
    agents.addCustom([
      buildGuideAgentDefinition(guideDir, { local: settings.guide.source === "local" }),
    ]);
  }
  // Silently warm the remote checkout in the background so the guide is ready
  // even when the MAIN agent auto-delegates to it — that path spawns the
  // sub-agent directly and never runs /nova-code-guide, which is what otherwise
  // clones. Fire-and-forget: no UI, non-blocking, failures only logged. Skipped
  // for source: "local" (nothing to clone); `ensureFresh` de-dupes against a
  // concurrent /nova-code-guide so this never double-clones.
  if (guideDir && settings.guide.source === "remote") {
    // Deferred via Promise.resolve().then so even a synchronous throw inside
    // ensureFresh becomes a rejection this .catch handles — nothing can escape
    // to disturb startup.
    void Promise.resolve()
      .then(() =>
        ensureFresh({
          repoUrl: settings.guide.repoUrl,
          ref: settings.guide.ref,
          cacheDir: settings.guide.cacheDir,
          maxAgeMs: settings.guide.refreshIntervalHours * 3_600_000,
          logger,
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "nova-code-guide: background checkout warm failed",
        );
      });
  }

  const todoStore = new TodoStore();
  // Tasks describe a PLAN, not a checkout, so they live at the repository root
  // (shared by every worktree of it) instead of inside the per-checkout dir —
  // switching worktrees must not lose the plan. In a normal checkout the root
  // IS the workspace, so behavior is unchanged there.
  const taskStore = new TaskStore(worktree?.main ?? workspace, session.id);
  // Scheduled tasks live under the session dir; the cron tools are gated by
  // settings.cron.enabled, but the store/scheduler always exist so `/loop` works
  // regardless (it rides the same mechanism, not the tool registration).
  const cronStore = new CronStore(session.dir, {
    minIntervalMs: settings.cron.minIntervalMs,
    maxIterations: settings.cron.maxIterations,
    maxSchedules: settings.cron.maxSchedules,
  });
  // Background command logs live beside the session's other artifacts, so they
  // are pruned with it by the session cleanup pass. The path of each `{id}.log`
  // is handed to the model in the `bash` result — reading a running command back
  // is a plain `read`/`grep` on that file, not a dedicated tool.
  const backgroundManager = new BackgroundCommandManager({
    outputDir: join(session.dir, "background"),
  });
  // Watch scripts (`monitor` tool). Their stdout lines become notifications;
  // stderr lands only in the per-monitor log beside the background ones.
  const monitorManager = new MonitorManager({
    maxConcurrent: settings.monitor.maxConcurrent,
    maxEventsPerWindow: settings.monitor.maxEventsPerWindow,
    windowMs: settings.monitor.windowMs,
    maxQueuedEvents: settings.monitor.maxQueuedEvents,
    maxLineBytes: settings.monitor.maxLineBytes,
    outputDir: join(session.dir, "monitors"),
  });
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
  // bash (and the sandbox, which wraps the same command).
  const pluginBinDirs = pluginResult.plugins.flatMap((p) => p.binDirs);
  if (pluginBinDirs.length > 0) {
    process.env.PATH = [...pluginBinDirs, process.env.PATH ?? ""].filter(Boolean).join(":");
  }
  const tools = new ToolRegistry().registerAll(
    builtinTools(
      todoStore,
      skillsOpts,
      taskStore,
      backgroundManager,
      lspManager,
      settings.cron.enabled ? cronStore : undefined,
      monitorManager,
      {
        keys: {
          brave: settings.websearch.braveApiKey,
          tavily: settings.websearch.tavilyApiKey,
          serper: settings.websearch.serperApiKey,
        },
      },
    ),
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
  const snapshotPathFor = async (
    use: ToolUseBlock,
    toolCtx: ToolContext,
  ): Promise<string | undefined> => {
    if (use.name !== "write" && use.name !== "edit") return undefined;
    const rawPath = (use.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
    return canonicalizePath(toolCtx.cwd, rawPath);
  };
  const rawDispatch = createDispatcher({
    registry: tools,
    logger,
    ...(invariants ? { invariants } : {}),
    lifecycle: {
      async beforeRun(use, toolCtx) {
        const path = await snapshotPathFor(use, toolCtx);
        if (path) await ctx.snapshots.capture(path);
      },
      async afterRun(use, toolCtx, result) {
        if (result.isError) return;
        const path = await snapshotPathFor(use, toolCtx);
        if (path) await ctx.snapshots.recordResult(path);
      },
    },
  });
  // Thread the OS sandbox bridge onto the ToolContext so subprocess tools
  // (bash, incl. run_in_background) — and sub-agent calls that reuse this
  // dispatch — wrap commands before spawning. File snapshots are dispatcher
  // lifecycle hooks above: capture → tool → result bookkeeping all remain
  // inside the same per-path serialized transaction.
  const dispatch: ToolExecutor = async (use, toolCtx) => {
    // ctx.sandbox is assigned after the sandbox write roots are computed below; its bridge is undefined
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
  // Per-request output-rate tracker behind the StatusLine's `tok/s` segment;
  // settled at `post_request` (hooks.ts), which also resets it.
  const outputRate = createOutputRateTracker();
  const pushSpinnerTokens = (progress: { inputTokens?: number; outputTokens: number }): void => {
    const now = Date.now();
    // Feed the tracker on every chunk — its window boundaries must not be
    // quantized by the UI throttle below.
    outputRate.onProgress(progress.outputTokens, now);
    // Output flowing again means we're past the retry backoff — restore the
    // default interrupt hint so a stale "retry n/max" doesn't linger on the
    // (now succeeding) request.
    if (retryHintShown && progress.outputTokens > 0) {
      retryHintShown = false;
      screen.setSpinnerHint(t.spinner.interruptHint);
    }
    if (now - lastTokenPush < 80) return;
    lastTokenPush = now;
    screen.setSpinnerTokens(progress);
    // Publish only a matured rate: while the window is too young to divide by,
    // the previous request's number stays on screen instead of flickering out.
    const live = outputRate.liveRate();
    if (live !== null) screen.setOutputTokensPerSec(live);
  };
  // Transient model failures are retried inside the model adapter — DeepSeek's
  // 429/500/503 (carry a `status`), malformed tool-call JSON, and dropped
  // connections (both carry a `reason` — "malformed-json" / "network"). Surface
  // each retry in the live spinner (n/max) so a stalled turn isn't a silent freeze.
  const onRetry = (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status?: number;
    reason?: string;
  }): void => {
    logger.warn(info, "model retry");
    retryHintShown = true;
    // The retry restarts the stream from zero output tokens, so close the rate
    // window too — otherwise it would span the backoff and report the pause as
    // slow generation.
    outputRate.reset();
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

  // `name` may be a bare model id or a key into the active provider's models;
  // resolveModelId
  // maps a known alias to its concrete id and passes anything else through, so
  // both /model tiers and raw ids work. Resolving here means every caller —
  // ctx.model, predictModel, and the sub-agent model cache — gets alias support
  // for free, and the resolved id is what reaches cost/pricing matching.
  const buildModel = (name: string, trackTokens = true): ModelClient => {
    // Resolve the connection on every construction. `/connect` mutates
    // `currentProvider`, then rebuilds the main/predict clients through this
    // factory; `/model`, sub-agents, compaction and classifiers consequently
    // follow the new endpoint, key, transport and profile too.
    const currentProvider = activeProvider(settings);
    if (!currentProvider) {
      throw new Error("currentProvider does not name a configured provider");
    }
    const currentApiKey = resolveApiKey(settings);
    if (!currentApiKey) {
      throw new Error(`active provider apiKey is not set (nor in $${API_KEY_ENV})`);
    }
    const currentProfile = activeProviderProfile(settings) ?? currentProvider.name;
    const currentHeaders = activeProviderHeaders(settings);
    const currentRequestParams = activeProviderRequestParams(settings);
    const model = resolveModelId(settings, name);
    return createModel({
      apiKey: currentApiKey,
      model,
      provider: resolveProfile(currentProfile),
      // Lets the adapter clamp `max_tokens` so prompt + completion fits: the
      // provider counts both against the window, and the tier's cap (393k on a
      // 1M DeepSeek window) otherwise makes long conversations fail at ~63%.
      contextWindowSize: resolveContextWindowSize(settings, name),
      // Explicit wire-protocol override; omitted → the profile's default
      // transport. Lets e.g. `profile: "deepseek"` run against DeepSeek's
      // OpenAI-compatible endpoint (baseURL without the /anthropic suffix).
      ...(currentProvider.transport ? { transport: currentProvider.transport } : {}),
      ...(currentProvider.baseURL ? { baseURL: currentProvider.baseURL } : {}),
      ...(currentHeaders ? { headers: currentHeaders } : {}),
      ...(currentRequestParams ? { requestParams: currentRequestParams } : {}),
      ...(trackTokens
        ? { onStreamProgress: pushSpinnerTokens, onStreamText: pushLiveText, onRetry }
        : {}),
    });
  };

  // Timing engine for scheduled entries. Only needs `wake` (running happens in the
  // REPL poll), and `screen` is stable across session switches, so it's built here
  // and re-created in switchToSession pointing at the new session's store.
  const cronScheduler = new CronScheduler({ store: cronStore, wake: () => screen.wake() });

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
    goal: null,
    sessionName: null,
    cronStore,
    cronScheduler,
    spinner: null,
    todoAutoClearTimer: null,
    taskAutoClearTimer: null,
    taskStartedAt: null,
    outputRate,
    nextPlaceholder: "",
    planGateArmed: false,
    planApprovalAskedThisTurn: false,
    pendingAutoCompactNotice: null,
    apiKey,
    workspace,
    worktree: worktree ?? null,
    setWorkspace: null as unknown as CliContext["setWorkspace"],
    memory,
    reloadMemory: null as unknown as CliContext["reloadMemory"],
    skillsBlock,
    // Rendered once the registry is final — see the assignment after
    // applyToolDenylist, and the field's doc comment.
    toolsGuidance: "",
    version,
    noTranscript,
    noPretty,
    screen,
    resetLiveStream,
    todoStore,
    taskStore,
    backgroundManager,
    monitorManager,
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
    permissionGate: null as unknown as CliContext["permissionGate"],
    compactor: null as unknown as CliContext["compactor"],
    agent: null as unknown as Agent,
    buildLogger,
    buildModel,
  };

  // Worktree tools are host-owned: `enterWorktree`/`exitWorktree` call
  // `ctx.setWorkspace`, which rebuilds every workspace-scoped binding. They are
  // registered here, before `permissions.deny`, so a user can remove either by
  // name like any other builtin. Their guidance is gated on the final registry
  // (see WORKTREE_PROMPT in @nova/tools).
  registerWorktreeTools(ctx);

  // Re-read memory from disk and swap in the fresh bundle. Only invoked at a
  // session boundary (switchToSession), where the prefix is already rebuilt, so
  // it never disturbs an in-session prefix cache. The agent reads the bundle via
  // `getMemory: () => ctx.memory`, so the next turn picks this up automatically.
  ctx.reloadMemory = async () => {
    // Reads the LIVE workspace: a worktree switch reloads memory from the
    // checkout the session is in now (the auto-memory dir stays repo-keyed).
    ctx.memory = await loadMemory(ctx.workspace, memoryOptsFor(ctx.workspace, ctx.worktree?.main));
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
    const answer = await ctx.screen.promptApproval(decision, input, promptOpts);
    // A deliberate "Deny" at an interactive prompt ends the whole turn, exactly
    // like Esc — the user is rejecting this action, so don't keep prompting for
    // the remaining tools in the batch one by one. Aborting the in-flight turn
    // makes the loop cancel every sibling tool (granted-but-unrun via the signal
    // check in phase 2, not-yet-prompted via phase 1) and stop without another
    // model round-trip. Esc already resolves to "no" via onCancel above, so that
    // re-abort is a no-op; an explicit Deny click reaches here without having
    // aborted yet. Gated on `interactive` so a headless "deny" policy — which
    // returns "no" with no human present — keeps its per-tool denial semantics.
    if (answer === "no" && ctx.screen.interactive) {
      ctx.agent.abort(new Error("tool permission denied by user"));
    }
    return answer;
  };

  // Two root sets on purpose:
  //  - writeRoots: where write/edit run without a prompt in auto/acceptEdits,
  //    and where the OS sandbox permits filesystem writes. The workspace cwd
  //    plus `permissions.additionalDirectories` (that setting has always meant
  //    "read AND write" — see config.ts).
  //  - readRoots: what read/glob/grep may touch without a prompt. The write set
  //    plus `permissions.readOnlyDirectories` and the Nova Code Guide checkout
  //    (a read-only reference tree — auto mode must not be able to write it).
  // Canonicalized here so the engine's `within` matcher compares real on-disk
  // paths (a symlinked cwd still matches) — and rebuilt by `setWorkspace`,
  // which is why both are `let`: a worktree switch moves the fence.
  const buildWriteRoots = (ws: string): Promise<string[]> =>
    canonicalizeRoots([ws, ...settings.permissions.additionalDirectories], ws);
  const buildReadRoots = (ws: string, write: readonly string[]): Promise<string[]> =>
    canonicalizeRoots(
      [...write, ...settings.permissions.readOnlyDirectories, ...(guideDir ? [guideDir] : [])],
      ws,
    );
  let writeRoots = await buildWriteRoots(workspace);
  let readRoots = await buildReadRoots(workspace, writeRoots);
  // The agent maintains its own auto-memory store under this directory; auto-allow
  // read/write/edit inside it so persisting a learned fact doesn't prompt. Resolve
  // to the same canonical form the gate compares paths in (the dir may not exist
  // yet — canonicalizePath folds that to the logical absolute path).
  const autoMemoryDirFor = async (
    ws: string,
    autoDir: string | undefined,
  ): Promise<string | undefined> =>
    autoDir !== undefined ? await canonicalizePath(ws, autoDir) : undefined;
  let autoMemoryDir = await autoMemoryDirFor(workspace, memoryOpts.autoDir);
  // Captured-output dirs are the model's read-back path for still-running work
  // (`bash` returns a background command's `output_path`; `monitor` returns its
  // watch script's `log_path`) and for the images the user pastes into the
  // prompt (repl.ts saves them under `session.dir/images`). read/grep must be
  // allowed there — they live under the session dir, outside the workspace fence.
  const sessionCaptureDirs = await Promise.all(
    ["background", "monitors", "images"].map((d) =>
      canonicalizePath(workspace, join(session.dir, d)),
    ),
  );
  const buildPermission = (roots: readonly string[], memoryDir: string | undefined) =>
    new PermissionEngine({
      defaultEffect: settings.permissions.defaultEffect,
      rules: resolvePermissionRules(settings, roots, memoryDir, sessionCaptureDirs),
      ask: askWithSignal,
    });
  let permission = buildPermission(readRoots, autoMemoryDir);
  (ctx as { permission: PermissionEngine }).permission = permission;

  // OS command sandbox (opt-in). Confines subprocess writes to the same
  // writeRoots the permission engine's write grants use, plus the auto-memory store: that
  // store now lives OUTSIDE the workspace (under ~/.nova), so — unlike the old
  // in-repo `.nova/memory` — it must be added to the sandbox write allowlist for
  // a shelled-out memory write to succeed when the sandbox is on. Network is
  // unrestricted by default unless the user sets `sandbox.network.allowedDomains`.
  // createSandbox never throws — on an unsupported platform / missing deps /
  // disabled it returns an inactive control and tools run unsandboxed. The bridge
  // is read by the dispatch closure above via the `sandboxBridge` variable.
  let sandboxWriteRoots = autoMemoryDir ? [...writeRoots, autoMemoryDir] : writeRoots;
  const buildSandbox = (enabled: boolean): Promise<SandboxControl> =>
    createSandbox({
      enabled,
      writeRoots: sandboxWriteRoots,
      // A linked worktree's object database lives in the MAIN checkout's `.git`,
      // outside the worktree path — see `sandboxGitAllowWrite`.
      extraAllowWrite: [
        ...settings.sandbox.filesystem.allowWrite,
        ...sandboxGitAllowWrite(ctx.worktree),
      ],
      denyWrite: settings.sandbox.filesystem.denyWrite,
      denyRead: settings.sandbox.filesystem.denyRead,
      allowGitConfig: settings.sandbox.filesystem.allowGitConfig,
      monitorViolations: settings.sandbox.monitorViolations,
      network: settings.sandbox.network,
      logger,
    });
  const sandboxControl = await buildSandbox(settings.sandbox.enabled);
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

  // Runtime toggle for the `/sandbox` command. Captures sandboxWriteRoots/logger
  // so the rebuilt control confines writes to the same roots as the initial one.
  // The dispatch closure reads ctx.sandbox.bridge lazily, so reassigning here
  // flips sandboxing on the next subprocess tool. This toggle only mutates the
  // live control/settings; the `/sandbox` command persists the choice to
  // nova.config.json separately via saveSettings.
  (ctx as { setSandbox: CliContext["setSandbox"] }).setSandbox = async (enabled) => {
    await ctx.sandbox?.dispose();
    ctx.settings.sandbox.enabled = enabled;
    const next = await buildSandbox(enabled);
    (ctx as { sandbox: SandboxControl }).sandbox = next;
    await ctx.transcript.append({
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
    // workspace and user-defined rules match canonical absolute paths. The
    // path is resolved through `aliasedPath` (filePath/file_path/file) because
    // schema-level alias normalization happens later, in the dispatcher: reading
    // `input.path` here would judge an alias-only call as "no path" and gate it
    // against the workspace root instead of its real target. We never mutate the
    // caller's input (the tool still runs on its own copy); the canonical path
    // is used for evaluation only.
    const evalInput = await canonicalizeGateInput(
      tool,
      input as Record<string, unknown>,
      ctx.workspace,
    );
    // Worktree isolation outranks every grant below: once the session works in
    // a linked worktree, the main checkout is one directory away and shares the
    // object database, so `acceptEdits`, a session "always allow", or a user
    // rule must not be able to reach back into it. Only an explicit
    // bypassPermissions mode skips these checks (matching Claude Code).
    if (
      settings.worktree.enforceIsolation &&
      ctx.worktree &&
      ctx.screen.getPermissionMode() !== "bypassPermissions"
    ) {
      const denial = worktreeIsolationDenial({
        // `main` is absent when git metadata cannot name the main checkout; the
        // guard then classifies each target against `gitDir` instead.
        ...(ctx.worktree.main ? { main: ctx.worktree.main } : {}),
        gitDir: ctx.worktree.gitDir,
        workspace: ctx.workspace,
        checkouts: ctx.worktree.checkouts,
        tool,
        // `evalInput` carries the canonical `cwd`/`path`; the command text and
        // every other field pass through unchanged.
        input: evalInput,
        ...(PATH_INPUT_TOOLS.has(tool) && typeof evalInput.path === "string"
          ? { path: evalInput.path }
          : {}),
      });
      if (denial) return { granted: false, reason: denial.reason };
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
    // the real on-disk path. A null decision means "no mode opinion — defer to
    // the rules/prompt flow below".
    const mode = ctx.screen.getPermissionMode();
    const modeDecision = resolveModeDecision(
      mode,
      tool,
      PATH_INPUT_TOOLS.has(tool) ? (evalInput.path as string) : undefined,
      writeRoots,
      { canSelfExit: settings.planMode.agentTools, input: evalInput },
    );
    // Plan mode is an outright denial: it outranks every grant below, including
    // a session-scoped always-allow. Read-only has to stay read-only.
    if (modeDecision?.granted === false) return modeDecision;
    // A user-configured `deny` rule is absolute. The mode grants below
    // (acceptEdits/auto writes) and auto's classifier shortcut would otherwise
    // return without ever consulting the engine, silently overriding it.
    // `deniedByRule` keeps the engine's first-match-wins semantics.
    const ruleDenial = permission.deniedByRule({ tool, input: evalInput });
    if (ruleDenial) return { granted: false, reason: ruleDenial.reason };
    if (modeDecision) return modeDecision;
    // `auto` mode's read fast path: toolchain / package-manager / temp trees
    // (see read-policy.ts) are read-only by construction, and reading them is
    // the common out-of-workspace operation. Runs after the deny rules above,
    // so an explicit user deny still wins; sensitive paths are excluded inside
    // the helper. Everything else keeps the normal ask flow, where
    // "always allow reads in <dir>" turns N prompts into one per directory.
    if (mode === "auto" && AUTO_READ_TOOLS.has(tool)) {
      const readPath = evalInput.path;
      if (typeof readPath === "string" && isAutoAllowedReadPath(readPath)) {
        return { granted: true };
      }
    }
    // `auto` mode runs commands unattended, but only after a risk classifier
    // clears them (static rules first, then an LLM call for the rest). A risky
    // verdict falls back to a confirmation prompt — Claude Code's auto-mode
    // fallback-to-prompting — rather than denying outright, so the user keeps
    // control while genuinely-safe commands run without interruption.
    // A remembered "always allow this tool" skips the classifier, but NOT the
    // engine: falling through to `permission.check` still enforces the
    // dangerous-bash hard deny, which `evaluate` applies before any runtime
    // allow. Returning a bare grant here would let a session grant swallow it.
    const sessionAllowed = permission.isSessionAllowed({ tool, input: evalInput });
    if (mode === "auto" && MODE_COMMAND_TOOLS.has(tool) && !sessionAllowed) {
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
        (activeModels(ctx.settings)[DEFAULT_CHEAP_TIER] ? DEFAULT_CHEAP_TIER : ctx.settings.model);
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
      if (answer === "no") {
        return { granted: false, reason: "denied at auto-mode risk prompt" };
      }
      // The prompt is outside PermissionEngine.check (auto's classifier owns
      // the decision), so record the same tool-scoped grant here — otherwise
      // "Always allow this tool" would be forgotten before the next command.
      if (answer === "always-allow") permission.allowToolForSession(tool);
      return { granted: true };
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

  // The permission engine as a port: same decisions, addressed by tool_use block
  // so the gate can correlate with the pre_/post_permission events.
  (ctx as { permissionGate: CliContext["permissionGate"] }).permissionGate = {
    check: (use) => ctx.checkPermission(use.name, use.input),
  };

  (ctx as { compactor: CliContext["compactor"] }).compactor = buildCompactor({
    auto: settings.compact.auto,
    // Non-streaming client (trackTokens=false): the summarizer's output must
    // not leak into the live draft / spinner like a normal turn — it's internal
    // machinery, surfaced only via the post_compact card. Built from the live
    // model name so it still follows /model switches.
    getModel: () => ctx.buildModel(ctx.settings.model, false),
    // Both read live so the threshold follows a /model switch to another tier
    // (different window) or another provider (different tokenizer ratios).
    getContextWindowSize: () => resolveContextWindowSize(ctx.settings, ctx.settings.model),
    getTokenEstimate: () =>
      resolveProfile(activeProviderProfile(ctx.settings) ?? "generic").tokenEstimate,
    getOverheadTokens: () => fixedOverheadTotal(measureCtxOverhead(ctx)),
    // The tier's output cap sets the reserve the trigger must leave free, so
    // compaction fires before `prompt + max_tokens` can overrun the window.
    getMaxTokens: () => resolveMaxTokens(ctx.settings, ctx.settings.model),
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
    const signal = ctx.agent.currentSignal();
    return await ctx.screen.askUser(req, signal ? { signal } : undefined);
  };

  const assembled = assembleSession({
    workspace,
    // Live binding: the worktree tools move the session to another checkout, and both
    // the tool host's `cwd` and the system prompt read it per use.
    getWorkspace: () => ctx.workspace,
    getSessionId: () => ctx.session.id,
    getLogger: () => ctx.logger,
    memory: {
      getMemory: () => ctx.memory,
      getWorkspace: () => ctx.workspace,
      getWorktree: () =>
        ctx.worktree
          ? {
              path: ctx.worktree.path,
              gitDir: ctx.worktree.gitDir,
              ...(ctx.worktree.main ? { main: ctx.worktree.main } : {}),
              ...(ctx.worktree.branch ? { branch: ctx.worktree.branch } : {}),
            }
          : undefined,
      // The workspace is part of the prompt text, so a worktree switch has to
      // advance the epoch — otherwise `freezeSystemPrompt` would (correctly)
      // discard the new prompt and the model would keep describing the old
      // checkout. Same mechanism `/resume` uses.
      getEpoch: () => `${ctx.session.id}\u0000${ctx.workspace}`,
      // Read late (the block is rendered below, after every registration), but
      // constant from the first turn on — never a live view of the registry.
      getToolsGuidance: () => ctx.toolsGuidance,
      // Sub-agents render their own from their filtered tool set.
      renderToolsGuidance,
      getLanguage: () => ctx.settings.language,
    },
    getMessagesPath: () => ctx.session.messagesPath,
    ...(ctx.noTranscript ? {} : { getTranscript: () => ctx.transcript }),
    getPersistCursor: () => ctx.persistCursor,
    setPersistCursor: (c) => {
      ctx.persistCursor = c;
    },
    // Live binding: ctx.model is rebuilt on /model switch. Slicing to the
    // model-facing view is the loop's job now (compactor.view).
    getModel: () => ctx.model,
    getThinkingLevel: () => ctx.thinkingLevel,
    getSettings: () => ({
      maxTokens: resolveMaxTokens(ctx.settings, ctx.settings.model),
      maxTurns: ctx.settings.maxTurns,
      maxTokensContinuations: ctx.settings.maxTokensContinuations,
      toolConcurrency: ctx.settings.toolConcurrency,
      modelModalities: resolveModelModalities(ctx.settings, ctx.settings.model),
      effort: ctx.thinkingLevel,
    }),
    getTools: () => ctx.tools.definitions(),
    dispatch: ctx.dispatch,
    permission: ctx.permissionGate,
    compactor: ctx.compactor,
    fileLedger,
    askUser,
    getMessages: () => ctx.screen.getMessages(),
    subagent: {
      enabled: settings.subagent.enabled,
      getAgentRegistry: () => ctx.agents,
      // Sub-agents must NOT drive the parent's live spinner token counter.
      // Several run concurrently and each onStreamProgress callback reports that
      // agent's own running total (not a sum), so sharing the tracked model
      // would make the parent spinner's "↓ ~N tok" flicker between agents and
      // read as garbage — hence trackTokens=false.
      buildModel: (id) => buildModel(id, false),
      // The agent package caches sub-agent clients. Include the live connection
      // name so `/connect` cannot reuse a `pro`/`max` client built for the prior
      // provider; names are unique within `providers[]`.
      getModelCacheKey: (id) => `${activeProvider(ctx.settings)?.name ?? ""}\u0000${id}`,
      defaultModels: DEFAULT_SUBAGENT_MODELS,
      getModelOverrides: () => ctx.settings.subagent.model,
      // Sub-agents follow /model when nothing more specific is configured.
      getFallbackModelId: () => ctx.settings.model,
      // The plan-mode pair: a sub-agent runs inside the parent session, so
      // letting it flip the PARENT's permission mode (or ask the user to leave
      // plan mode on its behalf) is never right.
      //
      // Worktree tools are withheld for the same reason: they move the LIVE
      // session's workspace, so a child calling one would move the parent
      // mid-turn (and its own tool cwd underneath it).
      excludeTools: [...PLAN_MODE_TOOL_NAMES, ...WORKTREE_TOOL_NAMES],
      getSessionDir: () => ctx.session.dir,
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
        toolConcurrency: ctx.settings.toolConcurrency,
        modelModalities: resolveModelModalities(ctx.settings, ctx.settings.model),
      }),
    },
  });

  (ctx as { agent: Agent }).agent = assembled.agent;
  // createSubAgent goes into the same registry the parent reads, so the main
  // agent can spawn children. Every dep reads its binding lazily, so
  // registering after assembly is safe.
  if (assembled.subAgentTool) ctx.tools.register(assembled.subAgentTool);

  // Agent-driven plan mode: let the model put itself into the read-only `plan`
  // permission mode and ask to leave it once the plan is ready. The mode itself
  // stays the screen's (same source of truth shift+tab writes and
  // `checkPermission` reads), so the status-line indicator, the permission gate,
  // and the `pre_request` plan-mode reminder all follow an agent-driven flip
  // exactly as they follow a human one.
  if (settings.planMode.agentTools) {
    ctx.tools.registerAll(
      createPlanModeTools({
        isActive: () => ctx.screen.getPermissionMode() === "plan",
        // The mode to restore afterwards is recorded by the store on the way in
        // (`modeBeforePlan`), so shift+tab and this tool are remembered alike.
        enter: () => ctx.screen.setPermissionMode("plan"),
        // The plan is NOT drawn here: the transcript already renders this
        // call's `plan` argument as prose in place of its (hidden) tool row —
        // see planToRender — so a card would be a second copy of it.
        requestExit: async () => {
          // Tell the REPL's end-of-turn gate that this turn already asked, so
          // a rejection here is not immediately followed by the same prompt.
          ctx.planApprovalAskedThisTurn = true;
          const decision = await askPlanApproval(askUser, ctx.screen);
          // A bare "keep planning" — or a dismissed prompt — ends the turn,
          // exactly like an explicit Deny at a permission prompt: the loop
          // cancels any sibling tool and stops without another model
          // round-trip, and the user gets the input box back with plan mode
          // still on. Feedback typed instead keeps the turn running so the
          // model can revise against it. See shouldStopTurn.
          if (shouldStopTurn(decision)) {
            ctx.agent.abort(new Error("plan not approved by user"));
          }
          return decision;
        },
      }),
    );
  }

  // permissions.deny (bare-name removal): now that every tool is registered —
  // builtins, MCP tools/resources, and createSubAgent — drop each denied name
  // from the shared registry so it disappears from the model's advertised tools,
  // sub-agents, and /context, and can't be dispatched. The rules-based
  // `effect: "deny"` still exists for call-time rejection; this is the stronger
  // "model never sees it" form (and saves the tool's schema tokens per request).
  const denylist = applyToolDenylist(ctx.tools, settings.permissions.deny);
  for (const name of denylist.removed) {
    logger.info({ tool: name }, "tool disabled via permissions.deny");
  }
  for (const name of denylist.missing) {
    logger.warn({ tool: name }, "permissions.deny lists an unknown tool (ignored)");
  }

  // THE snapshot point. Everything that adds or removes a tool has now run —
  // builtins, MCP, createSubAgent, the plan-mode pair, permissions.deny — so
  // this is the first and only moment the set is final. Rendering earlier would
  // advertise denied tools; re-rendering later would drift the system prompt
  // inside an epoch, which freezeSystemPrompt discards with a warning.
  ctx.toolsGuidance = renderToolsGuidance(ctx.tools.definitions());

  registerUiHooks(ctx);
  // Keep the pinned mode-row indicator in sync from the manager's own push
  // signal. This also catches background commands started by sub-agents, whose
  // message lifecycle is separate from the main agent's UI hooks.
  const refreshBackgroundCommands = (): void => {
    screen.setRunningBackgroundCount(
      backgroundManager.list().filter((command) => command.status === "running").length,
    );
  };
  backgroundManager.onChange(refreshBackgroundCommands);
  refreshBackgroundCommands();

  // Consume queued input MID-TASK: `pre_continue` fires at each tool-iteration
  // boundary, so a prompt the user typed while the agent is still working gets
  // injected as a user message right away — the model folds it into the running
  // task instead of the user waiting for the turn to end. Registered before the
  // reminder interjects (pre_continue is first-non-undefined-wins) so a real
  // user prompt outranks a todo/task nudge; the nudge just fires a turn later. A
  // task that ends with no tool calls never reaches pre_continue — the loop
  // returns and the REPL's own takeInput drains the queue into the next round.
  // Only plain prompts are taken here (see takeQueuedPrompt); `/` slash and `!`
  // shell lines stay queued for the REPL. Gated live so /config toggles it.
  ctx.agent.on("pre_continue", () => {
    if (!ctx.settings.queue.consumeInLoop) return undefined;
    const line = ctx.screen.takeQueuedPrompt();
    if (line === null) return undefined;
    return { messages: [userText(line)] };
  });

  registerInterject(ctx.agent, makeTodoReminder(todoStore));
  registerInterject(ctx.agent, makeTaskReminder(taskStore));
  ctx.agent.on("pre_request", makeBackgroundNotifier(backgroundManager));
  ctx.agent.on("pre_request", makeMonitorNotifier(monitorManager));
  // Keep the model's view honest about plan mode on the next real request
  // (lazy, trigger-agnostic: shift+tab and the agent's own enterPlanMode /
  // exitPlanMode are announced identically). Registered AFTER the background
  // notifier so that on the rare turn where both want to inject, the notifier
  // wins the first-non-undefined-wins race; the reminder compares against the
  // visible history rather than a latch, so losing that race just defers it to
  // the next request.
  ctx.agent.on(
    "pre_request",
    makePlanModeReminder(() => ctx.screen.getPermissionMode(), {
      canSelfExit: settings.planMode.agentTools,
    }),
  );

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

  // Same push path for monitor events — the difference is only what triggers
  // it: a background command fires once on exit, a monitor fires per event.
  if (ctx.settings.monitor.autoContinueOnEvent) {
    monitorManager.onEvents(() => {
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
    getCwd: () => ctx.workspace,
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
  const skillCmds = loadSkillCommandsInto(ctx.registry, {
    cwd: workspace,
    settings,
    logger,
    plugins: pluginResult.plugins,
    getSessionId: () => ctx.session.id,
    getEffort: () => ctx.thinkingLevel,
  });
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
      let skipped = 0;
      const msgs = await loadMessages(session.messagesPath, {
        onSkip: ({ line, error }) => {
          skipped += 1;
          logger.warn({ line, err: error }, "skipped unreadable message");
        },
      });
      // An empty cursor forces the next write to rewrite the file, which is what
      // we want after skipping unreadable lines: appending would keep them
      // wedged in the file forever. Rewriting purges them once and heals it.
      ctx.persistCursor =
        msgs.length === 0 || skipped > 0
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
      ctx.screen.card(dim(t.resume.loadedMessages(msgs.length)), { persist: false });
      if (skipped > 0) {
        ctx.screen.card(t.resume.skippedMessages(skipped), { kind: "warn", persist: false });
      }
      ctx.screen.setMessages(msgs);
      // Restore an active /goal so auto-continuation survives a restart.
      ctx.goal = await loadGoal(session.dir);
      // Rebuild the session-cumulative token counters (cache hit rate / `/usage`)
      // from the transcript so they survive a restart.
      // One pass rebuilds both the cumulative counters and the context-window
      // meter, so the launch path parses the transcript once rather than twice.
      const restored = await restoreFromTranscript(
        session.transcriptPath,
        join(session.dir, "subagents"),
      );
      ctx.screen.seedUsage(restored.totals);
      // Seed the context-window meter from the last request's total so it shows
      // real occupancy on launch, not 0% until the first model turn.
      ctx.screen.setContextTokens(restored.contextTokens);
      logger.info({ count: msgs.length }, "messages restored");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "failed to load messages");
      await fatalExit(ctx.screen, `failed to load messages: ${msg}`);
    }
  }

  // Load + arm persisted schedules. On a fresh session this is a no-op; on resume
  // it re-arms the session's cron entries (intervals one interval out, cron at the
  // next matching minute).
  await ctx.cronScheduler.init();

  /**
   * Move the session to another checkout of the same repository (a worktree).
   *
   * Everything workspace-shaped was built once, from the launch directory, and
   * is embedded in live objects: the memory bundle (byte 0 of the prompt), the
   * permission fence, the sandbox allowlist, the LSP root, and every tool's
   * `cwd`. They are rebuilt here in one place, in dependency order, so a switch
   * can never leave the session half-moved. The prompt itself is allowed to
   * change because the epoch getter folds in the workspace (see assembleSession).
   *
   * Switches are serialized: the move is a multi-step async transaction, and
   * two overlapping calls would otherwise leave the permission engine, sandbox
   * roots and `session.json` describing different checkouts.
   */
  const performWorkspaceSwitch = async (nextWorkspace: string): Promise<WorktreeBinding | null> => {
    const target = resolve(nextWorkspace);
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat?.isDirectory()) {
      throw new Error(`not a directory: ${target}`);
    }

    const nextWorktree = (await worktreeBinding(target)) ?? null;
    // Same repository only: history, memory and permission rules were built for
    // this one, and silently adopting another project's files would leak them
    // across projects. Moving back to this repo's main checkout is allowed
    // (`nextWorktree === null`, repo equal).
    //
    // Identity is the SHARED GIT DIR, not a main-checkout path: with
    // `git init --separate-git-dir` + a linked worktree the main working tree
    // cannot be named at all (`worktreeBinding().main` is undefined and
    // `mainCheckoutRoot` refuses to guess), yet both checkouts are plainly the
    // same repository. Comparing main paths rejected that switch outright
    // ("not inside …") after `enterWorktree` had already created the checkout.
    // Canonicalize both sides: `git rev-parse` reports absolute but not
    // necessarily symlink-resolved paths, and a launch through `/tmp` or a
    // symlinked workspace would otherwise look like a different repository.
    const currentRepo = await repoIdentity(ctx.workspace, ctx.worktree?.gitDir);
    const nextRepo = await repoIdentity(target, nextWorktree?.gitDir);
    if (currentRepo && nextRepo && currentRepo !== nextRepo) {
      throw new Error(
        `refusing to switch checkouts across repositories: ${currentRepo} -> ${nextRepo}`,
      );
    }
    if (currentRepo && !nextRepo) {
      throw new Error(`refusing to switch to ${target}: not inside ${currentRepo}`);
    }

    ctx.workspace = target;
    (ctx as { worktree: WorktreeBinding | null }).worktree = nextWorktree;
    worktree = nextWorktree ?? undefined;

    // 1) Memory: project instruction files come from the new checkout; the
    //    auto-memory store stays keyed by the repository.
    await ctx.reloadMemory();

    // 2) Permission fence, from the same rules but the new roots.
    writeRoots = await buildWriteRoots(target);
    readRoots = await buildReadRoots(target, writeRoots);
    autoMemoryDir = await autoMemoryDirFor(target, autoDirFor(target, worktree?.main));
    permission = buildPermission(readRoots, autoMemoryDir);
    (ctx as { permission: PermissionEngine }).permission = permission;

    // 3) Sandbox: same toggle, new write fence. The old control is disposed
    //    before the new one exists so two platform sandboxes never overlap.
    sandboxWriteRoots = autoMemoryDir ? [...writeRoots, autoMemoryDir] : writeRoots;
    await ctx.sandbox?.dispose();
    const nextSandbox = await buildSandbox(ctx.settings.sandbox.enabled);
    (ctx as { sandbox: SandboxControl }).sandbox = nextSandbox;
    await ctx.transcript.append({
      kind: "sandbox_init",
      data: {
        active: nextSandbox.active,
        ...(nextSandbox.reason ? { reason: nextSandbox.reason } : {}),
      },
    });

    // 4) Language servers are bound to their root at spawn time.
    await ctx.lspManager?.setRoot(target);

    // 5) Re-bind the session, so a later `--resume` re-enters here.
    await writeSessionWorkspace(ctx.session, target, nextWorktree?.main);
    await ctx.transcript.append({
      kind: "workspace_switched",
      data: {
        cwd: target,
        ...(nextWorktree
          ? {
              worktree: {
                main: nextWorktree.main,
                ...(nextWorktree.branch ? { branch: nextWorktree.branch } : {}),
              },
            }
          : {}),
      },
    });
    ctx.logger.info({ workspace: target, main: nextWorktree?.main }, "workspace switched");
    refreshBanner(ctx);
    return nextWorktree;
  };

  let workspaceSwitchTail: Promise<unknown> = Promise.resolve();
  (ctx as { setWorkspace: CliContext["setWorkspace"] }).setWorkspace = (nextWorkspace) => {
    // Queue behind the previous switch. `run` on both settle paths means a
    // failed switch doesn't poison every later one.
    const run = (): Promise<WorktreeBinding | null> => performWorkspaceSwitch(nextWorkspace);
    const next = workspaceSwitchTail.then(run, run);
    workspaceSwitchTail = next.catch(() => {});
    return next;
  };

  return ctx;
}
