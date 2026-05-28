import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Rgb } from "../colors.js";
import type { AskUserRequest, AskUserResponse, MessageParam } from "@nova/core";
import type { Task, Todo } from "@nova/tools";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import type { BannerProps } from "./banner.js";
import type { BoxedInputOptions, SlashCommand } from "./input-box.js";
import type {
  HorizontalPickerOptions,
  PickerOptions,
} from "./picker.js";
import type { SetupEntry, SetupState } from "./setup-view.js";

export type SpinnerLabel =
  | string
  | {
      words: string[];
      tint?: Rgb;
      colorize?: (word: string) => string;
    };

export interface SpinnerSpec {
  id: number;
  label: SpinnerLabel;
  hint?: string;
  startedAt: number;
  activeWord: string;
}

export type ApprovalAnswer = "yes" | "no" | "always-allow";

export type CardKind = "info" | "warn" | "error";

/**
 * Inline UI entries that render in chronological place between messages but are
 * never sent to the model. Used for slash-command output and other CLI-side
 * notices that should appear in the time line rather than pile up at the top.
 *
 * `anchor` is the index of the message after which this card renders;
 * `-1` renders before all messages (e.g. session-load notices on /resume).
 *
 * `title` is an optional short label rendered above the body — slash commands
 * use it to display the invoked command name (e.g. "/think").
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
  | { kind: "pickH"; opts: HorizontalPickerOptions<unknown> };

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
  spinner: SpinnerSpec | null;
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
   * Active mouse-drag selection in viewport-line coordinates (0-indexed rows
   * into `visibleLines`, 0-indexed visual columns). Null when no drag is in
   * flight. Used by the viewport to paint inverse-video highlight on the
   * selected range and by Screen to extract the text on release.
   */
  selection: SelectionRect | null;
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
  contextWindowTokens: number;
  /**
   * Prompts the user submitted while a turn was running, waiting to be consumed
   * as their own turns once the current one finishes (FIFO). The permanent
   * InputBox renders these above itself so the user can see what's pending.
   * Items submitted while the REPL is idle are handed straight to the consumer
   * and never land here.
   */
  inputQueue: string[];
  /**
   * Slash commands offered by the permanent InputBox popup. Set once when the
   * REPL starts; the InputBox is always mounted now, so it can't read these
   * from a per-prompt modal anymore.
   */
  slashCommands: SlashCommand[];
  /**
   * Predicted next-input hint shown as the InputBox placeholder when the buffer
   * is empty. Refreshed by the REPL after each turn.
   */
  inputPlaceholder: string;
}

export interface SelectionRect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface AppActions {
  pushCard: (text: string, opts?: CardOptions) => void;
  clearCards: () => void;
  setBanner: (banner: BannerProps | null) => void;
  setMessages: (messages: MessageParam[]) => void;
  setThinkingLabel: (label: string | undefined) => void;
  setTodos: (todos: Todo[]) => void;
  setTasks: (tasks: Task[]) => void;
  startSpinner: (label: SpinnerLabel, hint?: string) => SpinnerHandle;
  setEscHandler: (fn: (() => void) | null) => void;
  beginSetup: (state: SetupState) => void;
  setSetupPrompt: (prompt: { label: string; hint: string } | null) => void;
  pushSetupEntry: (entry: SetupEntry) => void;
  endSetup: () => void;
  resolveModal: (value: unknown) => void;
  openInputModal: (opts: BoxedInputOptions) => Promise<string | null>;
  openApprovalModal: (
    decision: PermissionDecision,
    input: PermissionInput,
    opts?: { signal?: AbortSignal; onCancel?: () => void },
  ) => Promise<ApprovalAnswer>;
  openAskModal: (
    req: AskUserRequest,
    opts?: { signal?: AbortSignal },
  ) => Promise<AskUserResponse>;
  openPickModal: <T>(opts: PickerOptions<T>) => Promise<T | null>;
  openPickHorizontalModal: <T>(opts: HorizontalPickerOptions<T>) => Promise<T | null>;
  reset: () => void;
  setTerminalSize: (cols: number, rows: number) => void;
  /** Sticky-aware writeback used by the viewport after each measure. */
  reportViewportMetrics: (totalLines: number, viewportRows: number) => void;
  /** Scroll by `delta` lines. Negative = up. Disables stickToBottom on up. */
  scrollBy: (delta: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  /** Snapshot of the visible text — written back by the viewport each render. */
  setVisibleLines: (lines: string[]) => void;
  /** Show a transient notice; auto-clears after `ttlMs` (default 1000). */
  setCopyNotice: (text: string, ttlMs?: number) => void;
  setSelection: (rect: SelectionRect | null) => void;
  /** Set the session-level StatusLine metadata (clock origin, branch, window). */
  setStatusMeta: (meta: {
    sessionStartedAt: number;
    gitBranch: string | null;
    contextWindowTokens: number;
  }) => void;
  /** Update the latest-request token count shown by the StatusLine meter. */
  setContextTokens: (tokens: number) => void;
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
  /** Ask the idle REPL to stop (Ctrl+C with no turn running). */
  requestExit: () => void;
  setSlashCommands: (commands: SlashCommand[]) => void;
  setInputPlaceholder: (text: string) => void;
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

export function createAppStore(): AppStoreApi {
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

    function openModal<T>(
      modal: ModalState,
      signal?: AbortSignal,
      cancelValue?: T,
    ): Promise<T> {
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
      spinner: null,
      modal: null,
      escHandler: null,
      thinkingLabel: undefined,
      setup: null,
      termCols: process.stdout.columns ?? 80,
      termRows: process.stdout.rows ?? 24,
      scrollOffset: 0,
      stickToBottom: true,
      viewportTotalLines: 0,
      viewportRows: 0,
      visibleLines: [],
      copyNotice: null,
      selection: null,
      sessionStartedAt: null,
      gitBranch: null,
      contextTokens: 0,
      contextWindowTokens: 0,
      inputQueue: [],
      slashCommands: [],
      inputPlaceholder: "",

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
      },

      clearCards() {
        if (get().cards.length === 0) return;
        set({ cards: [] });
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
        set({ todos });
      },

      setTasks(tasks) {
        set({ tasks });
      },

      startSpinner(label, hint) {
        const id = ++spinnerCounter;
        const activeWord =
          typeof label === "string"
            ? label
            : (label.words[Math.floor(Math.random() * label.words.length)] ?? "working");
        const spec: SpinnerSpec = {
          id,
          label,
          ...(hint !== undefined ? { hint } : {}),
          startedAt: Date.now(),
          activeWord,
        };
        set({ spinner: spec });
        const startedAt = spec.startedAt;
        return {
          stop: (): void => {
            const cur = get().spinner;
            if (cur?.id !== id) return;
            set({ spinner: null });
          },
          elapsedMs: (): number => Date.now() - startedAt,
          label: (): string => {
            const cur = get().spinner;
            return cur?.id === id ? cur.activeWord : activeWord;
          },
        };
      },

      setEscHandler(fn) {
        set({ escHandler: fn });
      },

      beginSetup(state) {
        set({ setup: state });
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
        return openModal<AskUserResponse>(
          { kind: "ask", req },
          opts.signal,
          { answers: [], cancelled: true },
        );
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
          modal: null,
          scrollOffset: 0,
          stickToBottom: true,
          viewportTotalLines: 0,
          viewportRows: 0,
          contextTokens: 0,
        });
        // banner, thinkingLabel, and the session-level status meta
        // (sessionStartedAt / gitBranch / contextWindowTokens) are intentionally
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
        if (next === s.scrollOffset && s.stickToBottom === (next >= maxOffset)) return;
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

      setVisibleLines(lines) {
        // Reference equality check covers the no-op path; deeper equality
        // isn't worth it since the array is freshly built each render anyway.
        if (get().visibleLines === lines) return;
        set({ visibleLines: lines });
      },

      setCopyNotice(text, ttlMs = 1000) {
        set({ copyNotice: text });
        setTimeout(() => {
          if (get().copyNotice === text) set({ copyNotice: null });
        }, ttlMs);
      },

      setSelection(rect) {
        if (get().selection === rect) return;
        set({ selection: rect });
      },

      setStatusMeta(meta) {
        const s = get();
        if (
          s.sessionStartedAt === meta.sessionStartedAt &&
          s.gitBranch === meta.gitBranch &&
          s.contextWindowTokens === meta.contextWindowTokens
        ) {
          return;
        }
        set({
          sessionStartedAt: meta.sessionStartedAt,
          gitBranch: meta.gitBranch,
          contextWindowTokens: meta.contextWindowTokens,
        });
      },

      setContextTokens(tokens) {
        if (get().contextTokens === tokens) return;
        set({ contextTokens: tokens });
      },

      enqueueInput(line) {
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

      requestExit() {
        if (inputSlot.waiter) {
          const w = inputSlot.waiter;
          inputSlot.waiter = null;
          w(null);
          return;
        }
        inputSlot.exitRequested = true;
      },

      setSlashCommands(commands) {
        set({ slashCommands: commands });
      },

      setInputPlaceholder(text) {
        if (get().inputPlaceholder === text) return;
        set({ inputPlaceholder: text });
      },
    };
  });
}
