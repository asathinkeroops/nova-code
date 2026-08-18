import type { AgentRegistry, MemoryBundle, PersistCursor } from "@nova/agent";
import type {
  Agent,
  Compactor,
  FileAccessLedger,
  ModelClient,
  PermissionGate,
  ToolExecutor,
} from "@nova/core";
import type {
  ThinkingLevel,
} from "@nova/base";
import type { McpManager } from "@nova/mcp";
import type { SlashRegistry } from "./slash-registry.js";
import type { LspManager } from "@nova/lsp";
import type {
  BackgroundCommandManager,
  CronStore,
  MonitorManager,
  TaskStore,
  TodoStore,
  ToolRegistry,
} from "@nova/tools";
import type { Logger, Session, Settings, Transcript } from "@nova/base";
import type { PermissionEngine, SandboxControl } from "@nova/safety";
import type { GoalState } from "./goal.js";
import type { CronScheduler } from "./cron-scheduler.js";
import type { LoadedPlugin } from "./plugins/loader.js";
import type { UserHooks } from "./user-hooks.js";
import type { SnapshotStore } from "./snapshots.js";
import type { Screen, Spinner } from "./screen.js";

export interface CliRuntimeOptions {
  cwd?: string;
  resume?: string;
  continue?: boolean;
  noTranscript?: boolean;
  noPretty?: boolean;
  /**
   * Session-only reasoning-depth overrides from `--think`. Thinking is a
   * per-tier property, so these are NOT persisted — they just seed
   * ctx.thinkingLevel / ctx.thinkingBudgetOverride for this run, over the active
   * tier's level. `--think <level>` sets the former; `--think <n>` the latter.
   */
  thinkingLevelOverride?: ThinkingLevel;
  thinkingBudgetOverride?: number;
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

  /**
   * Active `/goal` for this session, or null. While set, the REPL auto-continues
   * after each turn until the condition is met (judged by a fast model) or the
   * continuation budget runs out. Persisted to `{session.dir}/goal.json`, so it
   * is reloaded on resume / session switch.
   */
  goal: GoalState | null;

  /**
   * User-assigned name for this session (`/rename`), or null when unset.
   * Persisted to the shared `~/.nova/session-names.json` (keyed by session id)
   * and shown as a badge on the InputBox top frame. Re-seeded from disk on
   * session switch (`/resume`, `/clear`).
   */
  sessionName: string | null;

  /**
   * Scheduled-task store + timing engine for this session. `/loop` and the
   * cronCreate/cronList/cronDelete tools both ride on these: the store persists
   * entries under `{session.dir}/cron/`, the scheduler arms timers and wakes the
   * REPL to run due payloads between turns (see `runDueCron` in repl.ts). Both are
   * rebuilt on session switch (`/resume`, `/clear`) so they point at the new
   * session dir; disposed on exit.
   */
  cronStore: CronStore;
  cronScheduler: CronScheduler;

  // ===== Mutable: UI / per-turn state =====
  spinner: Spinner | null;
  toolSpinnerTimer: NodeJS.Timeout | null;
  /**
   * Pending "all todos/tasks completed → wipe the finished list" timers.
   * Scheduled on post_turn when a store is fully completed; after
   * settings.{todo,task}.autoClearDelayMs they clear the store and refresh the
   * footer, so the ✓'d list is visible for a beat before it vanishes. Each new
   * schedule cancels the prior pending one; the condition and active-store
   * identity are re-checked at fire time. See scheduleTodoAutoClear /
   * scheduleTaskAutoClear.
   */
  todoAutoClearTimer: NodeJS.Timeout | null;
  taskAutoClearTimer: NodeJS.Timeout | null;
  /**
   * Epoch-ms the current agent turn's work began, or null between turns. The
   * working spinner is torn down and recreated at every model-call / tool phase
   * within a turn; anchoring the spinner's elapsed to this (set once per turn in
   * hooks.ts, cleared on post_turn/error) keeps the timer counting up across the
   * whole task instead of resetting each phase.
   */
  taskStartedAt: number | null;
  nextPlaceholder: string;
  /**
   * Plan-mode approval gate state, both reset/armed by `runTurn` in repl.ts.
   *
   * `planGateArmed` — a turn finished while plan mode was still on, so the REPL
   * should ask for approval before parking for input. `planApprovalAskedThisTurn`
   * — the `exitPlanMode` tool already asked during that turn, which suppresses
   * the gate so a rejection is not immediately re-asked by the host.
   */
  planGateArmed: boolean;
  planApprovalAskedThisTurn: boolean;
  /**
   * Carrier for the auto-compact summary card across the compactor →
   * post_compact window. The compactor's onAutoCompact callback stashes the
   * info here; the post_compact UI hook reads it back and pushes the card, so
   * the notice survives.
   */
  pendingAutoCompactNotice: { before: number; after: number } | null;

  /**
   * The active memory bundle. Reassigned ONLY at a session boundary via
   * `reloadMemory()` (see `switchToSession`), where the prefix is rebuilt
   * anyway — never mid-turn, or DeepSeek's prefix cache collapses (see the
   * prefix-caching contract in CLAUDE.md).
   */
  memory: MemoryBundle;
  /**
   * Re-read all memory layers from disk and swap in the fresh bundle. Call only
   * at a session boundary (`/clear`, `/resume`). Returns the new bundle.
   */
  reloadMemory: () => Promise<MemoryBundle>;

  // ===== Read-only after init =====
  readonly agent: Agent;
  readonly apiKey: string;
  readonly workspace: string;
  /**
   * Pre-rendered `<available-skills>` block. Not injected on its own — it is
   * one section of {@link toolsGuidance}; kept here so `/context` can report the
   * skills index as its own row. Empty when skills are disabled or no SKILL.md
   * files were found.
   */
  readonly skillsBlock: string;
  /**
   * The `<tool-guidance>` block injected into the system prompt: every
   * `ToolPromptSection` whose tools survived into the final registry, the
   * skills index included.
   *
   * Assigned ONCE in `createContext`, right after `applyToolDenylist` — the
   * point where MCP, `createSubAgent`, the plan-mode pair and
   * `permissions.deny` have all had their say, and the only moment the tool set
   * is final. Mutable purely because that moment comes
   * after the context object exists; nothing may rewrite it later, since the
   * system prompt is frozen for the epoch and byte 0 of the request prefix.
   */
  toolsGuidance: string;
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
  readonly backgroundManager: BackgroundCommandManager;
  /** Watch scripts started with the `monitor` tool; stopped on session exit. */
  readonly monitorManager: MonitorManager;
  /** LSP code-intelligence manager. Undefined when settings.lsp.enabled is false. */
  readonly lspManager: LspManager | undefined;
  /** OS command sandbox handle. Inactive (bridge undefined) unless opted in via settings.sandbox. */
  readonly sandbox: SandboxControl;
  /**
   * Toggle the OS sandbox at runtime (the `/sandbox` command). Disposes the
   * current control, rebuilds it with `enabled`, reassigns `ctx.sandbox`, and
   * mutates `ctx.settings.sandbox.enabled`. The dispatch closure reads
   * `ctx.sandbox.bridge` lazily per tool call, so the switch takes effect on the
   * next subprocess tool. Session-only — not persisted to nova.config.json.
   */
  readonly setSandbox: (enabled: boolean) => Promise<SandboxControl>;
  /** User-configured shell hooks (settings.hooks). Lifecycle events fire via `userHooks.fire(...)`. */
  readonly userHooks: UserHooks;
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
  /** Loaded plugins (contributions already folded into the registries); read by `/plugin`. */
  readonly plugins: readonly LoadedPlugin[];
  readonly dispatch: ToolExecutor;
  readonly fileLedger: FileAccessLedger;
  readonly permission: PermissionEngine;
  readonly checkPermission: (
    tool: string,
    input: unknown,
  ) => Promise<{ granted: boolean; reason?: string }>;
  /**
   * `checkPermission` as the port the agent and its sub-agents consume. Same
   * engine, addressed by `tool_use` block so a gate can correlate with the
   * permission events.
   */
  readonly permissionGate: PermissionGate;
  /** Model-facing view (`view`) plus the boundary-appending summarizer (`compact`). */
  readonly compactor: Compactor;

  // ===== Factory closures (close over apiKey / settings, etc.) =====
  readonly buildLogger: (destination: string) => Logger;
  readonly buildModel: (id: string, trackTokens?: boolean) => ModelClient;
}
