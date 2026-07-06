import type { Agent, PersistCursor } from "@nova/agent";
import type { MemoryBundle } from "@nova/context";
import type {
  FileAccessLedger,
  MessageParam,
  ModelClient,
  ThinkingLevel,
  ToolExecutor,
} from "@nova/core";
import type { SlashRegistry, McpManager } from "@nova/external";
import type { LspManager } from "@nova/lsp";
import type { Transcript } from "@nova/observability";
import type { BackgroundCommandManager, TaskStore, TodoStore, ToolRegistry } from "@nova/tools";
import type { Logger, Session, Settings } from "@nova/runtime";
import type { PermissionEngine } from "@nova/safety";
import type { SandboxControl } from "@nova/sandbox";
import type { AgentRegistry } from "@nova/subagent";
import type { GoalState } from "./goal.js";
import type { UserHooks } from "./user-hooks.js";
import type { SnapshotStore } from "./snapshots.js";
import type { Screen, Spinner } from "./screen.js";

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

  // ===== Mutable: UI / per-turn state =====
  spinner: Spinner | null;
  toolSpinnerTimer: NodeJS.Timeout | null;
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
  readonly backgroundManager: BackgroundCommandManager;
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
