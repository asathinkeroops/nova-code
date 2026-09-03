import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  AskUserRequest,
  AskUserResponse,
  MessageParam,
} from "@nova/core";
import type {
  AccountBalance,
} from "@nova/model";
import type { Task, Todo } from "@nova/tools";
import type { ModelRates } from "@nova/base";
import type { SubAgentDetail } from "@nova/agent";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import type { BannerProps } from "./render-item.js";
import type { BoxedInputOptions, SlashCommand } from "./input-box.js";
import { appendInputHistory } from "./input-history.js";
import type { HorizontalPickerOptions, PickerOptions, ViewerOptions } from "./picker.js";
import type { SliderPickerOptions } from "./slider.js";
import type { SetupEntry, SetupState } from "./setup-view.js";
import type { TrustState } from "./trust-view.js";
import type { PermissionMode } from "../permissions.js";
import type { ClipboardPaste } from "../image-paste.js";

export type SpinnerLabel =
  | string
  | {
      words: string[];
      /**
       * 16-colour fallback painter, used only where the terminal lacks
       * truecolor. With truecolor the spinner paints itself from the wordmark's
       * gradient (see ui/spinner.tsx) — there is no per-spinner hue.
       */
      colorize?: (word: string) => string;
    };

export interface SpinnerSpec {
  id: number;
  label: SpinnerLabel;
  hint?: string;
  startedAt: number;
  activeWord: string;
  /** Live estimate of output tokens streamed so far this request, if tracked. */
  tokens?: number;
  /** Real uploaded prompt tokens for this request, if tracked. */
  inputTokens?: number;
}

/** Accumulated streaming assistant content for the in-flight request. */
export interface LiveDraft {
  /** Visible answer text streamed so far. */
  text: string;
  /** Reasoning text streamed so far (rendered dimmed, like a thinking block). */
  thinking: string;
}

export type ApprovalAnswer = "yes" | "no" | "always-allow";

export type CardKind = "info" | "warn" | "error";

/** Tone for a transient input-box notice: green for success, red for a warning. */
export type NoticeTone = "success" | "warn";

/**
 * Inline UI entries that render in chronological place between messages but are
 * never sent to the model. Used for slash-command output and other CLI-side
 * notices that should appear in the time line rather than pile up at the top.
 *
 * `anchor` is the index of the message after which this card renders;
 * `-1` renders before all messages (e.g. session-load notices on /resume).
 *
 * `title` is an optional short label rendered above the body — slash commands
 * use it to display the invoked command name (e.g. "/effort").
 */
export interface Card {
  id: number;
  anchor: number;
  kind: CardKind;
  title?: string;
  text: string;
}

export interface CardOptions {
  kind?: CardKind;
  title?: string;
  /**
   * Whether this card should be persisted to `cards.jsonl` so it survives a
   * resume / session switch. Defaults to true. Set false for cards that are
   * regenerated on every load (session-load notices, project-hook banners) so
   * they don't accumulate duplicates across restarts.
   */
  persist?: boolean;
}

export type ModalState =
  | { kind: "input"; opts: BoxedInputOptions }
  | {
      kind: "approval";
      decision: PermissionDecision;
      input: PermissionInput;
      onCancel?: () => void;
    }
  | { kind: "ask"; req: AskUserRequest }
  | { kind: "pick"; opts: PickerOptions<unknown> }
  | { kind: "pickH"; opts: HorizontalPickerOptions<unknown> }
  | { kind: "slider"; opts: SliderPickerOptions<unknown> }
  | { kind: "viewer"; opts: ViewerOptions };

export interface SpinnerHandle {
  stop(): void;
  elapsedMs(): number;
  label(): string;
}

export interface AppState {
  /**
   * Header banner rendered at the top of the App. Updated in place when the
   * model or session changes; preserved across `reset()` since it tracks
   * process-level state, not conversation history.
   */
  banner: BannerProps | null;
  /**
   * Canonical projection of the loop's MessageParam[]. Updated by the
   * `post_messages` hook, and directly by /clear and /resume. The `<Messages>`
   * component renders this; no other path should print conversation content.
   * The loop commits tool_results incrementally, so a pending tool_use simply
   * means "no matching tool_result block in this array yet."
   */
  messages: MessageParam[];
  /**
   * Inline UI entries (slash-command output, etc.) interleaved with `messages`
   * by the renderer. Purely client-side — never persisted to messages.jsonl
   * and never sent to the model. Cleared on /clear and on post_compact so they
   * never outlive the messages they were anchored to.
   */
  cards: Card[];
  todos: Todo[];
  tasks: Task[];
  /** Number of commands currently running behind the pinned mode-row indicator. */
  runningBackgroundCount: number;
  spinner: SpinnerSpec | null;
  /**
   * In-progress assistant content for the active request, streamed token by
   * token. Rendered as the last transcript item (below the latest message,
   * above the spinner) and cleared the instant the final message lands via
   * `post_messages`. Null when no request is streaming.
   */
  liveDraft: LiveDraft | null;
  modal: ModalState | null;
  /**
   * Active turn interrupt handler, set by the REPL while a turn runs. The
   * permanent InputBox calls it on Esc / Ctrl+C to abort the turn; when it's
   * null (idle), Ctrl+C asks the REPL to exit instead.
   */
  escHandler: (() => void) | null;
  /**
   * Label appended to thinking headers in rendered assistant messages.
   * Updated by the CLI when the thinking level changes; undefined when
   * thinking is off.
   */
  thinkingLabel: string | undefined;
  /**
   * Active setup wizard state. When non-null, the App renders ONLY the
   * `<SetupView>` (plus any open modal) and suppresses every other branch
   * — banner, scrollback, messages, cards, spinner, footer all stay hidden
   * until setup completes and this returns to null.
   */
  setup: SetupState | null;
  /**
   * When set, the workspace-trust gate commandeers the whole screen (rendered
   * by `<TrustView>` plus the Yes/No `pick` modal), suppressing every other
   * branch until the user answers. Independent of `setup` — a different concern.
   */
  trust: TrustState | null;
  /**
   * Current terminal size, kept in sync via a `stdout.on("resize")` listener
   * wired in `Screen`. Used by the viewport to decide ANSI wrap width and how
   * many rows it gets.
   */
  termCols: number;
  termRows: number;
  /**
   * Scroll position into the viewport's flat line array. 0 = top of history;
   * grows as the user scrolls down. Clamped against `totalLines - viewportRows`
   * at slice time, so transient over-scroll never panics the renderer.
   */
  scrollOffset: number;
  /**
   * When true (default), new content auto-scrolls the viewport to the bottom.
   * Set to false the moment the user scrolls up; flips back to true when the
   * user scrolls back to the bottom or hits End (or starts typing — input
   * activity implies they're done browsing history).
   */
  stickToBottom: boolean;
  /**
   * Total line count of the most recently rendered viewport. Read-only from
   * the App's perspective — the viewport writes it back so scroll actions can
   * compute the bottom-stick offset without re-measuring.
   */
  viewportTotalLines: number;
  /**
   * Number of visible rows in the viewport from the last render. Same write-
   * back pattern as `viewportTotalLines`.
   */
  viewportRows: number;
  /**
   * True while the mouse is hovering the "Jump to bottom" hint, so it can render
   * a highlight. Set by the Screen-level mouse handlers via `hitTestJumpButton`.
   */
  jumpButtonHovered: boolean;
  /**
   * The ANSI lines the viewport painted this frame, in render order. The
   * mouse-drag handler reads this to map (terminalRow, terminalCol) back to
   * the underlying text when copying a selection. Always corresponds to
   * terminal rows starting at 1 (alt-screen origin).
   */
  visibleLines: string[];
  /**
   * Transient notice shown at the top-left of the InputBox, e.g. "✓ copied"
   * after a mouse drag. `setCopyNotice` schedules an auto-clear; the field
   * stays null when no notice is active.
   */
  copyNotice: string | null;
  /**
   * Tone for the active `copyNotice`: "success" renders green (e.g. "✓ copied"),
   * "warn" renders red (e.g. an unsupported-model warning). Ignored when
   * `copyNotice` is null.
   */
  copyNoticeTone: NoticeTone;
  /**
   * Host-provided image-paste handlers wired by the REPL once the session and
   * model are known: `capture` reads the clipboard into a file (Ctrl+V) and
   * returns its path; `attached` confirms the inserted path and warns when the
   * active model lacks an image modality. Null until wired (modal/setup boxes
   * never get it).
   */
  imagePaste: {
    capture: () => Promise<ClipboardPaste | null>;
    attached: (path: string) => void;
  } | null;
  /**
   * Active mouse-drag selection in viewport-line coordinates (0-indexed rows
   * into `visibleLines`, 0-indexed visual columns). Null when no drag is in
   * flight. Used by the viewport to paint inverse-video highlight on the
   * selected range and by Screen to extract the text on release.
   */
  selection: SelectionRect | null;
  /**
   * Click/hover target per visible viewport line (1:1 with the painted lines),
   * written back by the viewport each render. Holds a collapsible item's key on
   * its control row (tool-batch title / thinking "… +N lines" hint) and null
   * elsewhere, letting the mouse layer map a terminal row to that item. See
   * `measure.ts` `VisibleSlice`.
   */
  lineTargets: Array<string | null>;
  /**
   * Keys of the collapsible items (tool batches, committed thinking blocks) the
   * user has expanded (clicked open). Absent key = collapsed (the default). Read
   * by `buildRenderItems` to pick each item's render mode; cleared on `reset()`
   * (/clear) with the rest of the transcript.
   */
  expandedItems: Record<string, boolean>;
  /**
   * Key of the collapsible item the mouse is currently hovering, or null. Drives
   * the control-row hover highlight in the viewport. Purely visual; never
   * persisted.
   */
  hoveredItem: string | null;
  /**
   * Epoch-ms the active session was created. Drives the StatusLine elapsed
   * clock. Set by `setStatusMeta`; survives `reset()` (session-level state).
   */
  sessionStartedAt: number | null;
  /**
   * Current git branch of the workspace, or null when not a repo / detached.
   * Snapshotted by `setStatusMeta`; survives `reset()`.
   */
  gitBranch: string | null;
  /**
   * Token count of the most recent model request (input + cache + output) — a
   * proxy for how full the context window is. Reset to 0 on `reset()` (/clear).
   */
  contextTokens: number;
  /**
   * Configured context-window size in tokens, used as the denominator for the
   * StatusLine usage meter. Set by `setStatusMeta`; survives `reset()`.
   */
  contextWindowSize: number;
  /**
   * Session-cumulative prompt tokens served from cache (hits), summed across
   * every model request. Numerator of the cache-hit-rate meter. Reset to 0 on
   * `reset()` (/clear) — a fresh session starts with a cold cache.
   */
  cacheReadTokens: number;
  /** Session-cumulative prompt tokens written to cache (new entries). Reset on `reset()`. */
  cacheCreationTokens: number;
  /** Session-cumulative uncached prompt input tokens (neither read nor written). Reset on `reset()`. */
  uncachedInputTokens: number;
  /** Session-cumulative output (completion) tokens. Reset on `reset()`. */
  sessionOutputTokens: number;
  /**
   * Same three prompt-token buckets as above, but **all-time across every
   * session on this machine** — the "累计 / total" half of the StatusLine cache
   * meter. Seeded at boot from `~/.nova/usage.json` ({@link seedLifetimeUsage})
   * and grown by every {@link addUsage} thereafter; unlike the session counters
   * these deliberately survive `reset()` (/clear) and a session switch, so the
   * lifetime hit rate never restarts from zero.
   */
  lifetimeCacheReadTokens: number;
  lifetimeCacheCreationTokens: number;
  lifetimeUncachedInputTokens: number;
  /**
   * Active model's resolved per-token rates, or null when pricing is disabled
   * or the model is unpriced. Lets the StatusLine show an estimated session
   * cost from the cumulative token counters. Set by `setCostRates` (from
   * `refreshBanner`); survives `reset()` since the model is unchanged.
   */
  costRates: ModelRates | null;
  /**
   * DeepSeek account balance for the second StatusLine row, or null when not on
   * DeepSeek's official API (the only provider that exposes a balance endpoint)
   * or when a fetch has not yet succeeded. Account-level, so it survives
   * `reset()` (/clear) like the cost rates. Refreshed at startup and after each
   * turn by the REPL.
   */
  accountBalance: AccountBalance | null;
  /**
   * Prompts the user submitted while a turn was running, waiting to be consumed
   * as their own turns once the current one finishes (FIFO). The permanent
   * InputBox renders these above itself so the user can see what's pending.
   * Items submitted while the REPL is idle are handed straight to the consumer
   * and never land here.
   */
  inputQueue: string[];
  /**
   * Recent prompts the user submitted from the permanent InputBox, oldest first,
   * for ↑/↓ recall. Unlike the live message stream this is persisted to its own
   * `~/.nova` file, so it survives `/clear` and carries across sessions. Seeded
   * from disk at startup ({@link setInputHistory}) and extended on each submit
   * ({@link enqueueInput}); capped to the newest few entries.
   */
  inputHistory: string[];
  /**
   * User-assigned name for the active session (`/rename`), or null when unset.
   * Rendered as a coloured badge on the InputBox's top frame. Host-managed (not
   * touched by `reset()`): the CLI seeds it from the session's persisted
   * `name.txt` at startup and re-points it on every `/resume` / `/clear` session
   * switch, so it always tracks the live session.
   */
  sessionName: string | null;
  /**
   * Slash commands offered by the permanent InputBox popup. Set once when the
   * REPL starts; the InputBox is always mounted now, so it can't read these
   * from a per-prompt modal anymore.
   */
  slashCommands: SlashCommand[];
  /**
   * Workspace file snapshot for `@path` mention completion in the InputBox.
   * Refreshed by the REPL at startup and after each turn.
   */
  mentionFiles: string[];
  /**
   * Predicted next-input hint shown as the InputBox placeholder when the buffer
   * is empty. Refreshed by the REPL after each turn.
   */
  inputPlaceholder: string;
  /**
   * Map of expanded-model-text → original user input for slash commands that
   * expand into a longer prompt (e.g. `/agent`). The renderer shows the
   * original input for any user message whose content matches a key, so the
   * transcript reflects what the user typed rather than the expansion sent to
   * the model. Persisted per-session in `display-sidecar.jsonl` and reloaded
   * on `/resume` / `-c`; cleared on `/clear` (reset).
   */
  userDisplayOverrides: Record<string, string>;
  /**
   * Latest sub-agent progress details (thinking / tool_use / final), keyed by
   * the parent `createSubAgent` tool_use id. The renderer shows the most recent
   * few under that tool-call card. Updated live as a sub-agent runs and seeded
   * from `display-sidecar.jsonl` on resume (the canonical message only keeps
   * the sub-agent's final report, so these would otherwise be lost). See
   * `display-sidecar.ts`.
   */
  toolDetails: Record<string, SubAgentDetail[]>;
  /**
   * Input-box permission mode, cycled with shift+tab and shown as an indicator
   * below the InputBox. Read by the CLI's `checkPermission` to bias tool gating
   * (accept-edits auto-grants in-workspace writes; plan denies write/edit/bash).
   * Starts at `auto` — the startup default, overridable with `--permission-mode`.
   * Session-only (not persisted to config) and preserved across `reset()`
   * (`/clear`) like `inputPlaceholder`.
   */
  permissionMode: PermissionMode;
  /**
   * Whether the `bypassPermissions` mode is reachable in the shift+tab cycle.
   * Armed once per session by the `--dangerously-skip-permissions` startup flag
   * (see `enableBypass`); off otherwise so the dangerous mode can never be
   * cycled into by accident. Session-only; preserved across `reset()` (`/clear`)
   * like `permissionMode`. The bypass is *active* (every approval auto-granted,
   * short-circuiting `promptApproval`) only while `permissionMode ===
   * "bypassPermissions"`.
   */
  bypassAllowed: boolean;
  /**
   * The mode in effect immediately before the current run of plan mode, so
   * approving a plan returns the user to where they were rather than to a
   * hardcoded default. Recorded on every transition INTO `plan` — shift+tab,
   * `--permission-mode plan`, and the agent's own `enterPlanMode` all land in
   * the two actions below — and cleared on the way out, so it is null whenever
   * plan mode is off. `--permission-mode plan` seeds it from the startup
   * default (`auto`), which is where that session should return to.
   */
  modeBeforePlan: PermissionMode | null;
}

export interface SelectionRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface AppActions {
  pushCard: (text: string, opts?: CardOptions) => Card;
  clearCards: () => void;
  /** Replace the card list wholesale (used to restore persisted cards on load). */
  setCards: (cards: Card[]) => void;
  setBanner: (banner: BannerProps | null) => void;
  setMessages: (messages: MessageParam[]) => void;
  setThinkingLabel: (label: string | undefined) => void;
  setTodos: (todos: Todo[]) => void;
  setTasks: (tasks: Task[]) => void;
  setRunningBackgroundCount: (count: number) => void;
  startSpinner: (label: SpinnerLabel, hint?: string, startedAt?: number) => SpinnerHandle;
  /** Update the active spinner's live token counts (no-op if none). */
  setSpinnerTokens: (progress: { inputTokens?: number; outputTokens: number }) => void;
  /** Set/clear the active spinner's trailing hint (no-op if none). */
  setSpinnerHint: (hint: string | undefined) => void;
  /** Replace the active spinner's label in place (no-op if no spinner). */
  updateSpinnerLabel: (label: SpinnerLabel) => void;
  /** Append streamed assistant deltas to the live draft (starts one if none). */
  appendLiveDraft: (delta: { text?: string; thinking?: string }) => void;
  /** Drop the live draft — called when the final message replaces it. */
  clearLiveDraft: () => void;
  setEscHandler: (fn: (() => void) | null) => void;
  beginSetup: (state: SetupState) => void;
  setSetupPrompt: (prompt: { label: string; hint: string; provider?: string } | null) => void;
  pushSetupEntry: (entry: SetupEntry) => void;
  endSetup: () => void;
  beginTrust: (state: TrustState) => void;
  endTrust: () => void;
  resolveModal: (value: unknown) => void;
  openInputModal: (opts: BoxedInputOptions) => Promise<string | null>;
  openApprovalModal: (
    decision: PermissionDecision,
    input: PermissionInput,
    opts?: { signal?: AbortSignal; onCancel?: () => void },
  ) => Promise<ApprovalAnswer>;
  openAskModal: (req: AskUserRequest, opts?: { signal?: AbortSignal }) => Promise<AskUserResponse>;
  openPickModal: <T>(opts: PickerOptions<T>) => Promise<T | null>;
  openPickHorizontalModal: <T>(opts: HorizontalPickerOptions<T>) => Promise<T | null>;
  openSliderModal: <T>(opts: SliderPickerOptions<T>) => Promise<T | null>;
  openViewerModal: (opts: ViewerOptions, signal?: AbortSignal) => Promise<void>;
  reset: () => void;
  setTerminalSize: (cols: number, rows: number) => void;
  /** Sticky-aware writeback used by the viewport after each measure. */
  reportViewportMetrics: (totalLines: number, viewportRows: number) => void;
  /** Scroll by `delta` lines. Negative = up. Disables stickToBottom on up. */
  scrollBy: (delta: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  /** Set the hover highlight on the "Jump to bottom" hint (no-op if unchanged). */
  setJumpButtonHovered: (hovered: boolean) => void;
  /** Snapshot of the visible text — written back by the viewport each render. */
  setVisibleLines: (lines: string[]) => void;
  /** Show a transient notice; auto-clears after `ttlMs` (default 1000). */
  setCopyNotice: (text: string, ttlMs?: number, tone?: NoticeTone) => void;
  /** Wire (or clear) the host's image-paste handlers. */
  setImagePaste: (handlers: AppState["imagePaste"]) => void;
  setSelection: (rect: SelectionRect | null) => void;
  /** Record the per-line click/hover targets the viewport painted this frame. */
  setLineTargets: (targets: Array<string | null>) => void;
  /** Toggle a collapsible item (tool batch / thinking) between collapsed and expanded. */
  toggleItem: (key: string) => void;
  /** Set (or clear, with null) the collapsible item the mouse is hovering. No-op if unchanged. */
  setHoveredItem: (key: string | null) => void;
  /** Set the session-level StatusLine metadata (clock origin, branch, window). */
  setStatusMeta: (meta: {
    sessionStartedAt: number;
    gitBranch: string | null;
    contextWindowSize: number;
  }) => void;
  /** Update the latest-request token count shown by the StatusLine meter. */
  setContextTokens: (tokens: number) => void;
  /** Set the active model's per-token rates for the StatusLine cost segment. */
  setCostRates: (rates: ModelRates | null) => void;
  /** Set the DeepSeek account balance for the StatusLine (null hides the segment). */
  setAccountBalance: (balance: AccountBalance | null) => void;
  /**
   * Fold one request's usage into the session-cumulative token counters that
   * back the cache-hit-rate meter and `/usage`. Each field is added to its
   * running total; missing cache fields count as 0. The same usage is folded
   * into the all-time `lifetime*` counters and handed to
   * `opts.persistUsage` so it reaches `~/.nova/usage.json`.
   */
  addUsage: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }) => void;
  /**
   * Set the all-time (cross-session) prompt-token counters to absolute totals —
   * called at boot with what `~/.nova/usage.json` holds, and again after each
   * flush so a total that another running nova process advanced is picked up
   * rather than silently diverging.
   */
  seedLifetimeUsage: (totals: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    uncachedInputTokens: number;
  }) => void;
  /**
   * Set the session-cumulative token counters to absolute totals — used to
   * restore them from a resumed session's transcript so the cache-hit-rate
   * meter and `/usage` survive a restart.
   */
  seedUsage: (totals: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  }) => void;
  /**
   * Submit a prompt from the InputBox. If the REPL is idle (blocked in
   * `takeInput`) it's delivered immediately; otherwise it's appended to
   * `inputQueue` for the next turn.
   */
  enqueueInput: (line: string) => void;
  /**
   * Consumer side, called by the REPL. Resolves with the next queued prompt,
   * blocking until one arrives, or `null` when an exit was requested.
   */
  takeInput: () => Promise<string | null>;
  /**
   * Non-blocking peek-and-consume for the agent loop's `pre_continue` hook: if
   * the head of `inputQueue` is a plain model-bound prompt (not empty, not a `/`
   * slash or `!` shell line), dequeue and return it so the running turn can fold
   * it in mid-task. Slash / shell lines and an empty queue return `null`, leaving
   * them for the REPL's own `takeInput` to dispatch.
   */
  takeQueuedPrompt: () => string | null;
  /** Ask the idle REPL to stop (Ctrl+C with no turn running). */
  requestExit: () => void;
  /**
   * Wake an idle REPL: if it's blocked in `takeInput`, resolve it with
   * {@link CONTINUE_SENTINEL} so the loop runs a continuation turn instead of a
   * user prompt. No-op when not parked — the REPL's pre-park `hasPending` check
   * covers a completion that lands while it's busy.
   */
  wake: () => void;
  /** Replace the ↑/↓ recall history (used at startup to seed from disk). */
  setInputHistory: (history: string[]) => void;
  /** Set (or clear, with null) the active session's custom name badge. */
  setSessionName: (name: string | null) => void;
  setSlashCommands: (commands: SlashCommand[]) => void;
  setMentionFiles: (files: string[]) => void;
  setInputPlaceholder: (text: string) => void;
  /** Replace the display-override map (used on resume to seed from disk). */
  setUserDisplayOverrides: (overrides: Record<string, string>) => void;
  /** Record one expanded-text → original-input override. */
  addUserDisplayOverride: (expanded: string, rawInput: string) => void;
  /** Replace the sub-agent detail map (used on resume to seed from disk). */
  setToolDetails: (details: Record<string, SubAgentDetail[]>) => void;
  /** Set the latest details for one sub-agent tool_use (live updates). */
  setToolDetail: (toolUseId: string, entries: SubAgentDetail[]) => void;
  /** Advance the permission mode (default → acceptEdits → plan → …) and return the new one. */
  cyclePermissionMode: () => PermissionMode;
  /** Set the permission mode directly (e.g. seed the initial mode from a CLI flag). */
  setPermissionMode: (mode: PermissionMode) => void;
  /**
   * Arm the `bypassPermissions` mode (`--dangerously-skip-permissions`): unlock
   * it in the shift+tab cycle and switch into it now. shift+tab can still cycle
   * back out to a safe mode afterwards.
   */
  enableBypass: () => void;
}

export type AppStoreState = AppState & AppActions;
export type AppStoreApi = UseBoundStore<StoreApi<AppStoreState>>;

/**
 * Module-scoped slot for the currently-open modal's Promise resolver. Kept
 * outside the Zustand store because (a) it's a closure that doesn't need to
 * trigger React updates and (b) storing functions in the reactive state
 * complicates selector equality checks.
 */
interface ModalSlot {
  resolve: ((value: unknown) => void) | null;
  abortCleanup: (() => void) | null;
}

/**
 * Sentinel returned by `takeInput` when {@link AppActions.wake} unparks an idle
 * REPL for a background continuation (rather than a typed prompt). A NUL-led
 * control string the InputBox can never produce, so it never collides with real
 * user input.
 */
export const CONTINUE_SENTINEL = "\x00__nova_continue__";

/**
 * Value equality for the checklist footers.
 *
 * `refreshTodoFooter` / `refreshTaskFooter` run on every `post_messages` — which
 * the loop fires roughly `2 × toolCalls + 3` times per turn — and both stores
 * hand back a freshly cloned array each time. Without a value compare, each of
 * those publishes a new reference and re-renders the whole Viewport even when
 * the checklist is untouched. Every other setter in this store already guards
 * the no-op path; these two did not.
 */
/**
 * The next value of `modeBeforePlan` for a mode transition. Entering plan mode
 * remembers where we came from; every other transition clears it, since the
 * value is only meaningful while plan mode is on. Both mode-changing actions
 * route through this so no entry path can forget to record it.
 */
function planReturnTo(from: PermissionMode, to: PermissionMode): PermissionMode | null {
  return to === "plan" && from !== "plan" ? from : null;
}

function sameTodos(a: readonly Todo[], b: readonly Todo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return !!y && x.id === y.id && x.description === y.description && x.status === y.status;
  });
}

function sameTasks(a: readonly Task[], b: readonly Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      !!y &&
      x.id === y.id &&
      x.description === y.description &&
      x.status === y.status &&
      x.blockedBy.length === y.blockedBy.length &&
      x.blockedBy.every((dep, j) => dep === y.blockedBy[j])
    );
  });
}

export interface AppStoreOptions {
  /**
   * Persist the ↑/↓ recall history after a submit extends it. Called with the
   * full capped list (oldest first). Injected so the store stays free of file
   * I/O; the CLI wires it to the `~/.nova` history file. Best-effort — the store
   * does not await it.
   */
  persistInputHistory?: (history: string[]) => void;
  /**
   * Fold one request's usage into the cross-session ledger behind the
   * StatusLine's all-time cache hit rate. Called with the same per-request delta
   * `addUsage` just applied (never a running total — the ledger accumulates on
   * disk). Injected for the same reason as {@link persistInputHistory}: the
   * store does no file I/O and does not await it.
   */
  persistUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }) => void;
}

export function createAppStore(opts: AppStoreOptions = {}): AppStoreApi {
  const slot: ModalSlot = { resolve: null, abortCleanup: null };
  // Non-reactive consumer slot for the input queue: when the REPL is blocked in
  // `takeInput`, `waiter` holds its resolver so a submit can hand off directly.
  const inputSlot: { waiter: ((v: string | null) => void) | null; exitRequested: boolean } = {
    waiter: null,
    exitRequested: false,
  };
  let spinnerCounter = 0;
  let cardCounter = 0;

  return create<AppStoreState>((set, get) => {
    function clearSlot(): void {
      slot.resolve = null;
      if (slot.abortCleanup) {
        slot.abortCleanup();
        slot.abortCleanup = null;
      }
    }

    function openModal<T>(modal: ModalState, signal?: AbortSignal, cancelValue?: T): Promise<T> {
      // Defensive: cancel any previous modal so we never leak resolvers.
      if (slot.resolve) {
        const prev = slot.resolve;
        clearSlot();
        prev(undefined);
      }
      return new Promise<T>((resolve) => {
        slot.resolve = resolve as (v: unknown) => void;
        if (signal) {
          if (signal.aborted) {
            slot.resolve = null;
            resolve(cancelValue as T);
            return;
          }
          const onAbort = (): void => {
            if (!slot.resolve) return;
            const r = slot.resolve;
            clearSlot();
            set({ modal: null });
            r(cancelValue);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          slot.abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }
        set({ modal });
      });
    }

    return {
      // ===== State =====
      banner: null,
      messages: [],
      cards: [],
      todos: [],
      tasks: [],
      runningBackgroundCount: 0,
      spinner: null,
      liveDraft: null,
      modal: null,
      escHandler: null,
      thinkingLabel: undefined,
      setup: null,
      trust: null,
      termCols: process.stdout.columns ?? 80,
      termRows: process.stdout.rows ?? 24,
      scrollOffset: 0,
      stickToBottom: true,
      viewportTotalLines: 0,
      viewportRows: 0,
      jumpButtonHovered: false,
      visibleLines: [],
      copyNotice: null,
      copyNoticeTone: "success",
      imagePaste: null,
      selection: null,
      lineTargets: [],
      expandedItems: {},
      hoveredItem: null,
      sessionStartedAt: null,
      gitBranch: null,
      contextTokens: 0,
      contextWindowSize: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 0,
      sessionOutputTokens: 0,
      lifetimeCacheReadTokens: 0,
      lifetimeCacheCreationTokens: 0,
      lifetimeUncachedInputTokens: 0,
      costRates: null,
      accountBalance: null,
      inputQueue: [],
      inputHistory: [],
      sessionName: null,
      slashCommands: [],
      mentionFiles: [],
      inputPlaceholder: "",
      userDisplayOverrides: {},
      toolDetails: {},
      permissionMode: "auto",
      bypassAllowed: false,
      modeBeforePlan: null,

      // ===== Actions =====
      pushCard(text, opts = {}) {
        const id = ++cardCounter;
        const anchor = get().messages.length - 1;
        const card: Card = {
          id,
          anchor,
          kind: opts.kind ?? "info",
          text,
          ...(opts.title ? { title: opts.title } : {}),
        };
        set((s) => ({ cards: [...s.cards, card] }));
        return card;
      },

      clearCards() {
        if (get().cards.length === 0) return;
        set({ cards: [] });
      },

      setCards(cards) {
        // Keep the id counter ahead of restored ids so freshly pushed cards
        // never collide with persisted ones.
        for (const c of cards) if (c.id > cardCounter) cardCounter = c.id;
        set({ cards: [...cards] });
      },

      setBanner(banner) {
        set({ banner });
      },

      setMessages(messages) {
        set({ messages });
      },

      setThinkingLabel(label) {
        set({ thinkingLabel: label });
      },

      setTodos(todos) {
        if (sameTodos(get().todos, todos)) return;
        set({ todos });
      },

      setTasks(tasks) {
        if (sameTasks(get().tasks, tasks)) return;
        set({ tasks });
      },

      setRunningBackgroundCount(count) {
        if (get().runningBackgroundCount === count) return;
        set({ runningBackgroundCount: count });
      },

      startSpinner(label, hint, startedAt) {
        const id = ++spinnerCounter;
        const activeWord =
          typeof label === "string"
            ? label
            : (label.words[Math.floor(Math.random() * label.words.length)] ?? "working");
        const spec: SpinnerSpec = {
          id,
          label,
          ...(hint !== undefined ? { hint } : {}),
          // Anchor to the caller-supplied task start when given (so the timer
          // spans a whole turn); otherwise this spinner's own creation time.
          startedAt: startedAt ?? Date.now(),
          activeWord,
        };
        set({ spinner: spec });
        const anchoredAt = spec.startedAt;
        return {
          stop: (): void => {
            const cur = get().spinner;
            if (cur?.id !== id) return;
            set({ spinner: null });
          },
          elapsedMs: (): number => Date.now() - anchoredAt,
          label: (): string => {
            const cur = get().spinner;
            return cur?.id === id ? cur.activeWord : activeWord;
          },
        };
      },

      setSpinnerTokens({ inputTokens, outputTokens }) {
        const cur = get().spinner;
        if (!cur) return;
        if (cur.tokens === outputTokens && cur.inputTokens === inputTokens) return;
        set({ spinner: { ...cur, tokens: outputTokens, inputTokens } });
      },

      setSpinnerHint(hint) {
        const cur = get().spinner;
        if (!cur) return;
        if (cur.hint === hint) return;
        const next: SpinnerSpec = { ...cur };
        if (hint === undefined) delete next.hint;
        else next.hint = hint;
        set({ spinner: next });
      },

      updateSpinnerLabel(label) {
        const cur = get().spinner;
        if (!cur) return;
        const activeWord =
          typeof label === "string"
            ? label
            : (label.words[Math.floor(Math.random() * label.words.length)] ?? "working");
        if (cur.activeWord === activeWord) return;
        set({ spinner: { ...cur, label, activeWord } });
      },

      appendLiveDraft({ text, thinking }) {
        if (!text && !thinking) return;
        const cur = get().liveDraft;
        set({
          liveDraft: {
            text: (cur?.text ?? "") + (text ?? ""),
            thinking: (cur?.thinking ?? "") + (thinking ?? ""),
          },
        });
      },

      clearLiveDraft() {
        if (get().liveDraft === null) return;
        set({ liveDraft: null });
      },

      setEscHandler(fn) {
        set({ escHandler: fn });
      },

      beginSetup(state) {
        set({ setup: state });
      },

      beginTrust(state) {
        set({ trust: state });
      },

      endTrust() {
        set({ trust: null });
      },

      setSetupPrompt(prompt) {
        const cur = get().setup;
        if (!cur) return;
        set({ setup: { ...cur, currentPrompt: prompt } });
      },

      pushSetupEntry(entry) {
        const cur = get().setup;
        if (!cur) return;
        set({ setup: { ...cur, entries: [...cur.entries, entry] } });
      },

      endSetup() {
        set({ setup: null });
      },

      resolveModal(value) {
        const resolve = slot.resolve;
        clearSlot();
        if (get().modal !== null) set({ modal: null });
        if (resolve) resolve(value);
      },

      openInputModal(opts) {
        return openModal<string | null>({ kind: "input", opts }, undefined, null);
      },

      openApprovalModal(decision, input, opts = {}) {
        return openModal<ApprovalAnswer>(
          {
            kind: "approval",
            decision,
            input,
            ...(opts.onCancel ? { onCancel: opts.onCancel } : {}),
          },
          opts.signal,
          "no",
        );
      },

      openAskModal(req, opts = {}) {
        return openModal<AskUserResponse>({ kind: "ask", req }, opts.signal, {
          answers: [],
          cancelled: true,
        });
      },

      openPickModal<T>(opts: PickerOptions<T>) {
        return openModal<T | null>(
          { kind: "pick", opts: opts as PickerOptions<unknown> },
          undefined,
          null,
        );
      },

      openPickHorizontalModal<T>(opts: HorizontalPickerOptions<T>) {
        return openModal<T | null>(
          { kind: "pickH", opts: opts as HorizontalPickerOptions<unknown> },
          undefined,
          null,
        );
      },

      openSliderModal<T>(opts: SliderPickerOptions<T>) {
        return openModal<T | null>(
          { kind: "slider", opts: opts as SliderPickerOptions<unknown> },
          undefined,
          null,
        );
      },

      openViewerModal(opts: ViewerOptions, signal?: AbortSignal) {
        // A signal lets a caller close the pager programmatically (e.g. an OAuth
        // wait that ends when the browser redirect lands, not on a keypress).
        return openModal<void>({ kind: "viewer", opts }, signal, undefined);
      },

      /**
       * Clears conversation state. The Screen controller also unmounts and
       * remounts the Ink instance (and clears the terminal) — see
       * `Screen.reset()` — to drop any output that was already committed.
       */
      reset() {
        clearSlot();
        set({
          messages: [],
          cards: [],
          spinner: null,
          liveDraft: null,
          modal: null,
          scrollOffset: 0,
          stickToBottom: true,
          viewportTotalLines: 0,
          viewportRows: 0,
          jumpButtonHovered: false,
          contextTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          uncachedInputTokens: 0,
          sessionOutputTokens: 0,
          userDisplayOverrides: {},
          toolDetails: {},
          expandedItems: {},
          hoveredItem: null,
          lineTargets: [],
        });
        // banner, thinkingLabel, and the session-level status meta
        // (sessionStartedAt / gitBranch / contextWindowSize) are intentionally
        // preserved across reset — they track process/session state, not
        // conversation history. Only contextTokens resets, since /clear empties
        // the context window.
      },

      setTerminalSize(cols, rows) {
        const s = get();
        if (s.termCols === cols && s.termRows === rows) return;
        set({ termCols: cols, termRows: rows });
      },

      reportViewportMetrics(totalLines, viewportRows) {
        const s = get();
        let next: Partial<AppState> | null = null;
        if (s.viewportTotalLines !== totalLines || s.viewportRows !== viewportRows) {
          next = { viewportTotalLines: totalLines, viewportRows };
        }
        if (s.stickToBottom) {
          const wantOffset = Math.max(0, totalLines - viewportRows);
          if (wantOffset !== s.scrollOffset) {
            next = { ...(next ?? {}), scrollOffset: wantOffset };
          }
        }
        if (next) set(next);
      },

      scrollBy(delta) {
        const s = get();
        if (delta === 0) return;
        const maxOffset = Math.max(0, s.viewportTotalLines - s.viewportRows);
        const next = Math.max(0, Math.min(s.scrollOffset + delta, maxOffset));
        if (next === s.scrollOffset && s.stickToBottom === next >= maxOffset) return;
        set({
          scrollOffset: next,
          stickToBottom: next >= maxOffset,
        });
      },

      scrollToTop() {
        const s = get();
        if (s.scrollOffset === 0 && !s.stickToBottom) return;
        set({ scrollOffset: 0, stickToBottom: s.viewportTotalLines <= s.viewportRows });
      },

      scrollToBottom() {
        const s = get();
        const maxOffset = Math.max(0, s.viewportTotalLines - s.viewportRows);
        if (s.scrollOffset === maxOffset && s.stickToBottom) return;
        set({ scrollOffset: maxOffset, stickToBottom: true });
      },

      setJumpButtonHovered(hovered) {
        if (get().jumpButtonHovered === hovered) return;
        set({ jumpButtonHovered: hovered });
      },

      setVisibleLines(lines) {
        // Reference equality check covers the no-op path; deeper equality
        // isn't worth it since the array is freshly built each render anyway.
        if (get().visibleLines === lines) return;
        set({ visibleLines: lines });
      },

      setCopyNotice(text, ttlMs = 1000, tone = "success") {
        set({ copyNotice: text, copyNoticeTone: tone });
        setTimeout(() => {
          if (get().copyNotice === text) set({ copyNotice: null });
        }, ttlMs);
      },

      setImagePaste(handlers) {
        set({ imagePaste: handlers });
      },

      setSelection(rect) {
        if (get().selection === rect) return;
        set({ selection: rect });
      },

      setLineTargets(targets) {
        // The viewport hands back a fresh array each frame; only commit when the
        // mapping actually changed so idle frames don't churn the store.
        const cur = get().lineTargets;
        if (cur.length === targets.length && cur.every((t, i) => t === targets[i])) {
          return;
        }
        set({ lineTargets: targets });
      },

      toggleItem(key) {
        set((s) => {
          const next = { ...s.expandedItems };
          if (next[key]) delete next[key];
          else next[key] = true;
          return { expandedItems: next };
        });
      },

      setHoveredItem(key) {
        if (get().hoveredItem === key) return;
        set({ hoveredItem: key });
      },

      setStatusMeta(meta) {
        const s = get();
        if (
          s.sessionStartedAt === meta.sessionStartedAt &&
          s.gitBranch === meta.gitBranch &&
          s.contextWindowSize === meta.contextWindowSize
        ) {
          return;
        }
        set({
          sessionStartedAt: meta.sessionStartedAt,
          gitBranch: meta.gitBranch,
          contextWindowSize: meta.contextWindowSize,
        });
      },

      setCostRates(rates) {
        if (get().costRates === rates) return;
        set({ costRates: rates });
      },

      setAccountBalance(balance) {
        const cur = get().accountBalance;
        // Skip the update when nothing changed so an unchanged balance fetched
        // after every turn doesn't churn a re-render.
        if (
          cur === balance ||
          (cur &&
            balance &&
            cur.total === balance.total &&
            cur.currency === balance.currency &&
            cur.available === balance.available)
        ) {
          return;
        }
        set({ accountBalance: balance });
      },

      setContextTokens(tokens) {
        if (get().contextTokens === tokens) return;
        set({ contextTokens: tokens });
      },

      addUsage(usage) {
        set((s) => ({
          uncachedInputTokens: s.uncachedInputTokens + usage.inputTokens,
          cacheReadTokens: s.cacheReadTokens + (usage.cacheReadInputTokens ?? 0),
          cacheCreationTokens: s.cacheCreationTokens + (usage.cacheCreationInputTokens ?? 0),
          sessionOutputTokens: s.sessionOutputTokens + usage.outputTokens,
          lifetimeUncachedInputTokens: s.lifetimeUncachedInputTokens + usage.inputTokens,
          lifetimeCacheReadTokens: s.lifetimeCacheReadTokens + (usage.cacheReadInputTokens ?? 0),
          lifetimeCacheCreationTokens:
            s.lifetimeCacheCreationTokens + (usage.cacheCreationInputTokens ?? 0),
        }));
        // Hand the same delta to the cross-session ledger. Injected so the store
        // stays free of file I/O; best-effort, never awaited.
        opts.persistUsage?.(usage);
      },

      seedLifetimeUsage(totals) {
        const s = get();
        if (
          s.lifetimeCacheReadTokens === totals.cacheReadTokens &&
          s.lifetimeCacheCreationTokens === totals.cacheCreationTokens &&
          s.lifetimeUncachedInputTokens === totals.uncachedInputTokens
        ) {
          return;
        }
        set({
          lifetimeCacheReadTokens: totals.cacheReadTokens,
          lifetimeCacheCreationTokens: totals.cacheCreationTokens,
          lifetimeUncachedInputTokens: totals.uncachedInputTokens,
        });
      },

      seedUsage(totals) {
        set({
          cacheReadTokens: totals.cacheReadTokens,
          cacheCreationTokens: totals.cacheCreationTokens,
          uncachedInputTokens: totals.uncachedInputTokens,
          sessionOutputTokens: totals.outputTokens,
        });
        // The `lifetime*` counters are deliberately untouched: they span every
        // session, so switching sessions must not rewind them.
      },

      enqueueInput(line) {
        // Record into ↑/↓ recall before dispatching, so every submitted line is
        // captured whether it's handed straight to a waiting REPL or queued.
        const nextHistory = appendInputHistory(get().inputHistory, line);
        if (nextHistory !== get().inputHistory) {
          set({ inputHistory: nextHistory });
          opts.persistInputHistory?.(nextHistory);
        }
        if (inputSlot.waiter) {
          const w = inputSlot.waiter;
          inputSlot.waiter = null;
          w(line);
          return;
        }
        set((s) => ({ inputQueue: [...s.inputQueue, line] }));
      },

      takeInput() {
        const q = get().inputQueue;
        if (q.length > 0) {
          const [head, ...rest] = q;
          set({ inputQueue: rest });
          return Promise.resolve(head ?? null);
        }
        if (inputSlot.exitRequested) {
          inputSlot.exitRequested = false;
          return Promise.resolve(null);
        }
        return new Promise<string | null>((resolve) => {
          inputSlot.waiter = resolve;
        });
      },

      takeQueuedPrompt() {
        const q = get().inputQueue;
        const head = q[0];
        if (head === undefined) return null;
        const line = head.trim();
        // Only consume plain prompts bound for the model here. Slash (`/`) and
        // shell (`!`) lines carry local side effects, so leave them queued for
        // the REPL's dispatchLine; an empty line is likewise dropped by the REPL.
        if (line === "" || line.startsWith("/") || line.startsWith("!")) return null;
        set({ inputQueue: q.slice(1) });
        return line;
      },

      requestExit() {
        if (inputSlot.waiter) {
          const w = inputSlot.waiter;
          inputSlot.waiter = null;
          w(null);
          return;
        }
        inputSlot.exitRequested = true;
      },

      wake() {
        if (inputSlot.waiter) {
          const w = inputSlot.waiter;
          inputSlot.waiter = null;
          w(CONTINUE_SENTINEL);
        }
      },

      setInputHistory(history) {
        set({ inputHistory: history });
      },

      setSessionName(name) {
        if (get().sessionName === name) return;
        set({ sessionName: name });
      },

      setSlashCommands(commands) {
        set({ slashCommands: commands });
      },

      setMentionFiles(files) {
        set({ mentionFiles: files });
      },

      setInputPlaceholder(text) {
        if (get().inputPlaceholder === text) return;
        set({ inputPlaceholder: text });
      },

      cyclePermissionMode() {
        // `bypassPermissions` joins the cycle only once `--dangerously-skip-permissions`
        // has armed it (bypassAllowed); otherwise the dangerous mode is unreachable.
        const order: PermissionMode[] = get().bypassAllowed
          ? ["default", "acceptEdits", "auto", "plan", "bypassPermissions"]
          : ["default", "acceptEdits", "auto", "plan"];
        const cur = get().permissionMode;
        const idx = order.indexOf(cur);
        const next = order[(idx + 1) % order.length] ?? "default";
        set({ permissionMode: next, modeBeforePlan: planReturnTo(cur, next) });
        return next;
      },

      setPermissionMode(mode) {
        const cur = get().permissionMode;
        if (cur === mode) return;
        const modeBeforePlan = planReturnTo(cur, mode);
        // Seeding bypass directly (e.g. --permission-mode) also unlocks it in the cycle.
        set(
          mode === "bypassPermissions"
            ? { permissionMode: mode, bypassAllowed: true, modeBeforePlan }
            : { permissionMode: mode, modeBeforePlan },
        );
      },

      enableBypass() {
        set({ bypassAllowed: true, permissionMode: "bypassPermissions" });
      },

      setUserDisplayOverrides(overrides) {
        set({ userDisplayOverrides: overrides });
      },

      addUserDisplayOverride(expanded, rawInput) {
        set((s) => ({
          userDisplayOverrides: { ...s.userDisplayOverrides, [expanded]: rawInput },
        }));
      },

      setToolDetails(details) {
        set({ toolDetails: details });
      },

      setToolDetail(toolUseId, entries) {
        set((s) => ({
          toolDetails: { ...s.toolDetails, [toolUseId]: entries },
        }));
      },
    };
  });
}
