import React from "react";
import { render } from "ink";
import type { AskUserRequest, AskUserResponse, MessageParam } from "@nova/core";
import type { Task, Todo } from "@nova/tools";
import type { ModelRates } from "@nova/observability";
import type { AccountBalance } from "@nova/core";
import type { SubAgentDetail } from "@nova/subagent";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { App } from "./ui/app.js";
import { type ApprovalAnswer } from "./ui/approval.js";
import { type BannerProps } from "./ui/render-item.js";
import { type BoxedInputOptions, type SlashCommand } from "./ui/input-box.js";
import { copyToClipboard } from "./ui/clipboard.js";
import { attachFilteredStdin } from "./ui/mouse.js";
import { wrapStdout } from "./ui/sync-output.js";
import {
  getCursorTarget,
  markCursorPainted,
  setCursorParking,
  setCursorTarget,
  setCursorWriter,
} from "./ui/cursor-target.js";
import { getInputMouseController } from "./ui/input-mouse.js";
import { hitTestJumpButton } from "./ui/jump-button.js";
import { extractSelection } from "./ui/selection.js";
import { H_PAD } from "./ui/viewport.js";
import { type SetupEntry, type SetupState } from "./ui/setup-view.js";
import { type TrustState } from "./ui/trust-view.js";
import { type PermissionMode } from "./permissions.js";
import { type ClipboardPaste } from "./image-paste.js";
import {
  type HorizontalPickerOptions,
  type PickerOptions,
  type ViewerOptions,
} from "./ui/picker.js";
import { type SliderPickerOptions } from "./ui/slider.js";
import {
  createAppStore,
  type AppStoreApi,
  type Card,
  type CardOptions,
  type NoticeTone,
  type SpinnerHandle,
  type SpinnerLabel,
} from "./ui/store.js";
import { loadInputHistory, saveInputHistory } from "./ui/input-history.js";
import { GlobalUsageLedger, loadGlobalUsage } from "./ui/global-usage.js";

export type { SpinnerLabel } from "./ui/store.js";
export type Spinner = SpinnerHandle;

/**
 * Tear down Ink and exit with `message` on stderr. Used by start-up failures
 * and fatal mid-session errors — anything that needs to surface a message
 * the user can still see after Ink releases the terminal. Writing to stderr
 * AFTER unmount avoids interleaving with Ink's live-region paint.
 */
export async function fatalExit(screen: Screen, message: string, code: number = 2): Promise<never> {
  await screen.unmount();
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(code);
}

interface InkInstance {
  unmount(): void;
  waitUntilExit(): Promise<void>;
  clear(): void;
  rerender(node: React.ReactElement): void;
}

/**
 * Single owner of the terminal UI. Wraps an Ink render that owns the full
 * frame — banner, messages, cards, live region (spinner / footer / modals).
 *
 * All UI output goes through this class. Direct `process.stdout.write`
 * after `mount()` would corrupt Ink's render bookkeeping.
 *
 * TTY is required for the interactive UI: `mount()` drives Ink and the
 * alt-screen buffer. Non-TTY / headless (`-p`) runs use `HeadlessScreen`, a
 * subclass that no-ops `mount()` and the interactive prompts, so the agent
 * loop runs without ever touching the terminal.
 */
export interface ScreenOptions {
  /**
   * Wrap Ink's frame writes in Synchronized Output (DEC 2026) so each repaint
   * lands atomically and the erase→redraw flicker disappears. Defaults to on;
   * seeded from `settings.terminal.syncOutput`.
   */
  syncOutput?: boolean;
  /**
   * Park the real terminal cursor on the InputBox caret after each frame so it
   * — and any IME composition popup anchored to it — follows typing instead of
   * sitting at home. Defaults to on; seeded from `settings.terminal.cursorFollow`.
   */
  cursorFollow?: boolean;
}

export class Screen {
  /**
   * Cross-session token ledger behind the StatusLine's all-time cache hit rate.
   * Batches per-request usage and folds it into `~/.nova/usage.json`; each flush
   * pushes the merged total back into the store so a second nova process's spend
   * is picked up too.
   */
  private readonly globalUsage = new GlobalUsageLedger(undefined, (totals) =>
    this.store.getState().seedLifetimeUsage(totals),
  );
  private store: AppStoreApi = createAppStore({
    persistInputHistory: (history) => void saveInputHistory(history),
    persistUsage: (usage) => this.globalUsage.add(usage),
  });
  private instance: InkInstance | null = null;
  private mounted = false;
  private detachResize: (() => void) | null = null;
  private detachMouse: (() => void) | null = null;
  private detachAltScreen: (() => void) | null = null;
  /**
   * Persistence hook for inline cards, wired by the CLI context. `append` is
   * called for each pushed card (unless it opts out with `persist: false`);
   * `clear` is called when {@link clearCards} drops the timeline (compaction),
   * so the on-disk record is invalidated too. Null until wired / in tests.
   */
  private cardSink: { append: (card: Card) => void; clear: () => void } | null = null;
  private readonly syncOutput: boolean;
  private readonly cursorFollow: boolean;

  constructor(opts: ScreenOptions = {}) {
    this.syncOutput = opts.syncOutput ?? true;
    this.cursorFollow = opts.cursorFollow ?? true;
    // Seed ↑/↓ recall from the persisted `~/.nova` history. Fire-and-forget:
    // the InputBox reads it reactively, so it lights up once the read resolves.
    void loadInputHistory().then((history) => {
      if (history.length > 0) this.store.getState().setInputHistory(history);
    });
    // Same treatment for the all-time token ledger: the StatusLine shows the
    // session-only rate until the read lands, then re-renders with both.
    void loadGlobalUsage().then((totals) => this.store.getState().seedLifetimeUsage(totals));
  }

  /**
   * Whether this screen is a real interactive terminal UI driving Ink modals.
   * The base Screen prompts a human; `HeadlessScreen` overrides this to `false`
   * since it answers permission prompts from a fixed policy with nobody present.
   * Callers use it to tell a deliberate human "Deny" (which should end the turn)
   * apart from a headless policy denial.
   */
  get interactive(): boolean {
    return true;
  }

  mount(): void {
    if (this.mounted) return;

    // Enter the alternate screen buffer + home the cursor. Same trick `vim`
    // and `htop` use: we get a private full-screen buffer that doesn't share
    // scrollback with the shell, so the first frame always starts at row 1
    // and the user's original shell view is restored verbatim on exit.
    // Without this, the first frame would write from wherever the shell's
    // cursor was — pushing the banner top into scrollback on terminals that
    // don't behave identically to xterm (notably Warp).
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1049h\x1b[H");
    }
    // Safety net: alt-screen must be exited or the terminal stays blank
    // after a crash. Mirrors the mouse-mode disable hook in mouse.ts.
    let altExited = false;
    const exitAlt = (): void => {
      if (altExited) return;
      altExited = true;
      try {
        process.stdout.write("\x1b[?1049l");
      } catch {
        // ignore
      }
    };
    process.once("exit", exitAlt);
    this.detachAltScreen = (): void => {
      process.off("exit", exitAlt);
      exitAlt();
    };

    // Install the mouse-filtering stdin proxy BEFORE Ink mounts: Ink reads
    // from this stream and never sees raw mouse escape sequences (which
    // would otherwise leak into the input box as `[<64;78;51M` garbage).
    //
    // Mouse coords arrive 1-indexed (terminal convention) and reference
    // absolute terminal rows. The viewport always starts at row 1 (alt
    // screen), so visibleLines index = row - 1. Column is additionally
    // offset by the viewport's horizontal padding (H_PAD) so selection
    // coordinates map to the pre-wrapped content width.
    // A drag is routed to either the input box or the viewport based on where it
    // starts, and stays there for its whole lifetime (so dragging from one region
    // into the other doesn't switch mid-selection). `inputDrag` holds the input
    // box's selection endpoints in buffer offsets while such a drag is in flight.
    let dragTarget: "input" | "viewport" | null = null;
    let inputDrag: { anchor: number; head: number } | null = null;
    const filtered = attachFilteredStdin({
      onWheel: ({ delta }) => this.store.getState().scrollBy(delta),
      onJumpToBottom: () => this.store.getState().scrollToBottom(),
      onSelectStart: ({ row, col }) => {
        // A click on the "Jump to bottom" hint jumps and consumes the press (no
        // selection). It sits above the input box, outside the viewport lines.
        if (hitTestJumpButton(row, col)) {
          this.store.getState().scrollToBottom();
          return;
        }
        // A press on an input-box body line moves the caret there and arms a
        // potential text selection; everything else opens a viewport selection.
        const input = getInputMouseController();
        const offset = input?.hitTest(row, col) ?? null;
        if (input && offset !== null) {
          dragTarget = "input";
          inputDrag = { anchor: offset, head: offset };
          input.moveCaret(offset);
          return;
        }
        dragTarget = "viewport";
        // Drop any leftover input-box highlight so it doesn't linger once the
        // user starts selecting in the viewport instead.
        input?.setRange(null);
        const r = Math.max(0, row - 1);
        const c = Math.max(0, col - 1 - H_PAD);
        this.store.getState().setSelection({
          startRow: r,
          startCol: c,
          endRow: r,
          endCol: c,
        });
      },
      onSelectUpdate: ({ row, col }) => {
        if (dragTarget === "input") {
          const input = getInputMouseController();
          if (!input || !inputDrag) return;
          const head = input.hitTest(row, col);
          if (head === null) return; // pointer left the body rows — keep last
          inputDrag = { ...inputDrag, head };
          input.setRange(inputDrag);
          return;
        }
        const cur = this.store.getState().selection;
        if (!cur) return;
        this.store.getState().setSelection({
          ...cur,
          endRow: Math.max(0, row - 1),
          endCol: Math.max(0, col - 1 - H_PAD),
        });
      },
      onHover: ({ row, col }) => {
        const state = this.store.getState();
        // The "Jump to bottom" hint highlights on hover; it sits outside the
        // viewport lines, so check it first and clear any viewport-item highlight.
        if (hitTestJumpButton(row, col)) {
          state.setJumpButtonHovered(true);
          state.setHoveredItem(null);
          return;
        }
        state.setJumpButtonHovered(false);
        // Resolve the hovered terminal row to a collapsible item's control row
        // (tool-batch title or thinking "… +N lines" hint; its key lives in
        // lineTargets) and highlight it; null clears the highlight elsewhere.
        const key = state.lineTargets[Math.max(0, row - 1)] ?? null;
        state.setHoveredItem(key);
      },
      onSelectEnd: ({ row, col }, moved) => {
        // Finalise an input-box drag: a no-move release is just the caret click
        // already applied on press; a real drag copies the selected text and
        // leaves it highlighted until the next keystroke.
        if (dragTarget === "input") {
          const input = getInputMouseController();
          const drag = inputDrag;
          dragTarget = null;
          inputDrag = null;
          if (!input) return;
          if (!moved || !drag || drag.anchor === drag.head) {
            input.setRange(null);
            return;
          }
          const lo = Math.min(drag.anchor, drag.head);
          const hi = Math.max(drag.anchor, drag.head);
          const text = input.textBetween(lo, hi);
          if (text.length > 0 && copyToClipboard(text)) {
            this.store.getState().setCopyNotice("✓ copied selection to clipboard");
          }
          return;
        }
        dragTarget = null;
        const state = this.store.getState();
        const cur = state.selection;
        state.setSelection(null);
        // A press+release without movement is a click: toggle a collapsible item
        // (tool-batch / thinking / a body-bearing tool call's preview) open or
        // closed when the click lands on its control row. Drags fall through to
        // the copy path below.
        if (!moved) {
          const key = state.lineTargets[Math.max(0, row - 1)] ?? null;
          if (key !== null) state.toggleItem(key);
          return;
        }
        if (!cur) return;
        const lines = state.visibleLines;
        if (lines.length === 0) return;
        const text = extractSelection(lines, {
          startRow: cur.startRow,
          startCol: cur.startCol,
          endRow: Math.max(0, row - 1),
          endCol: Math.max(0, col - 1 - H_PAD),
        }).trim();
        if (text.length === 0) return;
        if (copyToClipboard(text)) {
          const charCount = [...text].length;
          state.setCopyNotice(
            `✓ copied ${charCount} char${charCount === 1 ? "" : "s"} to clipboard`,
          );
        }
      },
    });
    this.detachMouse = filtered.detach;

    // Wrap stdout so each Ink frame repaints atomically (Synchronized Output,
    // kills streaming flicker) and parks the real cursor on the InputBox caret
    // (so IME popups follow typing). Only meaningful on a TTY; the alt-screen
    // guard above already gates interactive output on isTTY. When both are off
    // there's nothing to add, so pass the raw stream.
    const wrap = this.syncOutput || this.cursorFollow;
    const parkCursor = this.cursorFollow && process.stdout.isTTY;
    // Tell the InputBox the real cursor is live on its caret so it drops its own
    // inverse caret cell (two carets stacked look wrong — see cursor-target.ts).
    setCursorParking(parkCursor);
    // A caret-only move (←/→, Ctrl+A/E, a click) leaves the frame byte-identical,
    // so Ink writes nothing and the frame below never runs — the cursor would be
    // stranded at its old column. Hand cursor-target.ts the RAW stdout (never the
    // wrapper, which would treat the escape as a frame) so it can park the cursor
    // itself in that case, and `onPark` so it stays quiet when a frame did it.
    setCursorWriter(parkCursor ? (seq: string): void => void process.stdout.write(seq) : null);
    const stdout =
      wrap && process.stdout.isTTY
        ? wrapStdout(process.stdout, {
            sync: this.syncOutput,
            ...(parkCursor ? { getCursor: getCursorTarget, onPark: markCursorPainted } : {}),
          })
        : process.stdout;
    this.instance = render(React.createElement(App, { store: this.store }), {
      stdin: filtered.stream,
      stdout,
      exitOnCtrlC: false,
    }) as InkInstance;
    this.mounted = true;

    // When cursor-follow is on, the stdout wrapper owns cursor visibility per
    // frame (shows it on the caret, hides it when no caret) — re-showing here
    // would just race that. When it's off, fall back to the old behavior: Ink's
    // log-update hides the cursor once on first paint (gated by an internal
    // `hasHiddenCursor` flag), so a one-time re-show keeps a visible cursor for
    // IME anchoring; Ink won't re-hide on later frames.
    if (!this.cursorFollow) {
      setImmediate(() => {
        if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
      });
    }

    // Keep the store's view of the terminal size current; the viewport reads
    // these to compute slice width and row budget.
    const setSize = (): void => {
      this.store
        .getState()
        .setTerminalSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    };
    setSize();
    process.stdout.on("resize", setSize);
    this.detachResize = () => process.stdout.off("resize", setSize);
  }

  async unmount(): Promise<void> {
    if (!this.mounted || !this.instance) return;
    const inst = this.instance;
    this.instance = null;
    this.mounted = false;
    if (this.detachResize) {
      this.detachResize();
      this.detachResize = null;
    }
    // Stop out-of-band cursor parking before Ink shuts down, so a caret target
    // left over from the unmounting tree can't write to the terminal afterwards.
    setCursorWriter(null);
    setCursorTarget(null);
    // Ink's `unmount()` synchronously calls `this.resolveExitPromise()`, which
    // is only created lazily on the first `waitUntilExit()` call. If we call
    // `unmount()` first, that resolver is undefined and Ink throws — leaving
    // the later `waitUntilExit()` hanging forever. Prime the promise first.
    const exit = inst.waitUntilExit();
    try {
      inst.unmount();
    } catch {
      // ignore
    }
    try {
      await exit;
    } catch {
      // ignore
    }
    // Detach mouse AFTER Ink shuts down so Ink can flush final cursor/setRawMode
    // state through our proxy before we end it and disable mouse reporting.
    if (this.detachMouse) {
      this.detachMouse();
      this.detachMouse = null;
    }
    // Restore the main screen buffer last so the shell sees its previous
    // state once everything else is cleaned up.
    if (this.detachAltScreen) {
      this.detachAltScreen();
      this.detachAltScreen = null;
    }
  }

  /**
   * Tear down the Ink tree and remount a fresh one. Used by /clear and
   * /resume to drop the rendered history and start over. With the alt-screen
   * buffer, re-entering already clears the buffer (xterm `?1049h` resets it
   * on switch), so no extra `\x1b[2J` is needed — and avoiding it keeps us
   * from blanking the user's main shell screen during the brief unmount gap.
   */
  async reset(): Promise<void> {
    await this.unmount();
    this.store.getState().reset();
    this.mount();
  }

  /**
   * Push an inline card into the conversation timeline. Cards render between
   * messages at the position they were pushed and are dropped on /clear and
   * post_compact — they never enter the model context or messages.jsonl.
   */
  card(text: string, opts: CardOptions = {}): void {
    if (text.length === 0 && !opts.title) return;
    const card = this.store.getState().pushCard(text, opts);
    if (opts.persist !== false) this.cardSink?.append(card);
  }

  clearCards(): void {
    this.store.getState().clearCards();
    this.cardSink?.clear();
  }

  /** Replace the on-screen cards (used to restore persisted cards on load). */
  setCards(cards: Card[]): void {
    this.store.getState().setCards(cards);
  }

  /**
   * Wire card persistence. Passing null detaches it (e.g. before a session
   * switch repoints the sink). See {@link cardSink}.
   */
  setCardSink(sink: { append: (card: Card) => void; clear: () => void } | null): void {
    this.cardSink = sink;
  }

  setBanner(banner: BannerProps | null): void {
    this.store.getState().setBanner(banner);
  }

  setStatusMeta(meta: {
    sessionStartedAt: number;
    gitBranch: string | null;
    contextWindowSize: number;
  }): void {
    this.store.getState().setStatusMeta(meta);
  }

  setContextTokens(tokens: number): void {
    this.store.getState().setContextTokens(tokens);
  }

  setCostRates(rates: ModelRates | null): void {
    this.store.getState().setCostRates(rates);
  }

  setAccountBalance(balance: AccountBalance | null): void {
    this.store.getState().setAccountBalance(balance);
  }

  addUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }): void {
    this.store.getState().addUsage(usage);
  }

  /**
   * Write out any usage still batched in the cross-session ledger. Called on
   * shutdown so the last turn's spend isn't lost with the process.
   */
  flushGlobalUsage(): Promise<void> {
    return this.globalUsage.flush();
  }

  seedUsage(totals: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  }): void {
    this.store.getState().seedUsage(totals);
  }

  /** Snapshot of the session-cumulative token counters (for `/usage`). */
  usage(): {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  } {
    const s = this.store.getState();
    return {
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      uncachedInputTokens: s.uncachedInputTokens,
      outputTokens: s.sessionOutputTokens,
    };
  }

  setSpinnerTokens(progress: { inputTokens?: number; outputTokens: number }): void {
    this.store.getState().setSpinnerTokens(progress);
  }

  setSpinnerHint(hint: string | undefined): void {
    this.store.getState().setSpinnerHint(hint);
  }

  appendLiveDraft(delta: { text?: string; thinking?: string }): void {
    this.store.getState().appendLiveDraft(delta);
  }

  clearLiveDraft(): void {
    this.store.getState().clearLiveDraft();
  }

  /** Consumer side of the input queue — resolves with the next prompt or null on exit. */
  takeInput(): Promise<string | null> {
    return this.store.getState().takeInput();
  }

  /**
   * Non-blocking: consume the next queued *model-bound* prompt (for the agent
   * loop's `pre_continue` hook), or null when the queue head is a slash/shell
   * line or the queue is empty. See store `takeQueuedPrompt`.
   */
  takeQueuedPrompt(): string | null {
    return this.store.getState().takeQueuedPrompt();
  }

  /** Wake an idle REPL for a background continuation (see store `wake`). */
  wake(): void {
    this.store.getState().wake();
  }

  setSlashCommands(commands: SlashCommand[]): void {
    this.store.getState().setSlashCommands(commands);
  }

  /** Set (or clear, with null) the active session's `/rename` name badge. */
  setSessionName(name: string | null): void {
    this.store.getState().setSessionName(name);
  }

  /** Replace the workspace file snapshot used for `@path` mention completion. */
  setMentionFiles(files: string[]): void {
    this.store.getState().setMentionFiles(files);
  }

  setInputPlaceholder(text: string): void {
    this.store.getState().setInputPlaceholder(text);
  }

  /** Current input-box permission mode (default / acceptEdits / plan). */
  getPermissionMode(): PermissionMode {
    return this.store.getState().permissionMode;
  }

  /**
   * The mode in effect just before plan mode was entered, or null when plan
   * mode is off. Approving a plan restores this rather than a fixed default, so
   * a user who was in `auto` lands back in `auto`.
   */
  getModeBeforePlan(): PermissionMode | null {
    return this.store.getState().modeBeforePlan;
  }

  /** Advance to the next permission mode; returns the new one. */
  cyclePermissionMode(): PermissionMode {
    return this.store.getState().cyclePermissionMode();
  }

  /** Seed the initial permission mode (e.g. from the `--permission-mode` flag). */
  setPermissionMode(mode: PermissionMode): void {
    this.store.getState().setPermissionMode(mode);
  }

  /**
   * Arm the auto-approve bypass (`--dangerously-skip-permissions`): switch into
   * `bypassPermissions` mode and unlock it in the shift+tab cycle. While that
   * mode is active, `promptApproval` resolves to `always-allow` without opening
   * a modal; shift+tab can still cycle back out to a safe mode.
   */
  enableBypass(): void {
    this.store.getState().enableBypass();
  }

  setTodos(todos: Todo[]): void {
    this.store.getState().setTodos(todos);
  }

  setTasks(tasks: Task[]): void {
    this.store.getState().setTasks(tasks);
  }

  setMessages(messages: MessageParam[]): void {
    this.store.getState().setMessages(messages);
  }

  /** Replace the slash-expansion display-override map (e.g. on resume). */
  setUserDisplayOverrides(overrides: Record<string, string>): void {
    this.store.getState().setUserDisplayOverrides(overrides);
  }

  /** Record one expanded-text → original-input display override. */
  addUserDisplayOverride(expanded: string, rawInput: string): void {
    this.store.getState().addUserDisplayOverride(expanded, rawInput);
  }

  /** Replace the sub-agent detail map (e.g. on resume). */
  setToolDetails(details: Record<string, SubAgentDetail[]>): void {
    this.store.getState().setToolDetails(details);
  }

  /** Set the latest progress details for one sub-agent tool_use. */
  setToolDetail(toolUseId: string, entries: SubAgentDetail[]): void {
    this.store.getState().setToolDetail(toolUseId, entries);
  }

  /**
   * Read the canonical message array. The store is the single source of
   * truth for conversation history; everything that previously held a
   * separate `ctx.messages` field now reads through here.
   */
  getMessages(): MessageParam[] {
    return this.store.getState().messages;
  }

  setThinkingLabel(label: string | undefined): void {
    this.store.getState().setThinkingLabel(label);
  }

  startSpinner(label: SpinnerLabel, hint?: string, startedAt?: number): SpinnerHandle {
    return this.store.getState().startSpinner(label, hint, startedAt);
  }

  updateSpinnerLabel(label: SpinnerLabel): void {
    this.store.getState().updateSpinnerLabel(label);
  }

  setEscHandler(fn: (() => void) | null): void {
    this.store.getState().setEscHandler(fn);
  }

  /** Wire (or clear) the input box's image-paste handlers. */
  setImagePaste(
    handlers: {
      capture: () => Promise<ClipboardPaste | null>;
      attached: (path: string) => void;
    } | null,
  ): void {
    this.store.getState().setImagePaste(handlers);
  }

  /** Show a transient notice near the input box (auto-clears after `ttlMs`). */
  notice(text: string, ttlMs?: number, tone?: NoticeTone): void {
    this.store.getState().setCopyNotice(text, ttlMs, tone);
  }

  beginSetup(state: SetupState): void {
    this.store.getState().beginSetup(state);
  }

  setSetupPrompt(prompt: { label: string; hint: string; provider?: string } | null): void {
    this.store.getState().setSetupPrompt(prompt);
  }

  pushSetupEntry(entry: SetupEntry): void {
    this.store.getState().pushSetupEntry(entry);
  }

  endSetup(): void {
    this.store.getState().endSetup();
  }

  beginTrust(state: TrustState): void {
    this.store.getState().beginTrust(state);
  }

  endTrust(): void {
    this.store.getState().endTrust();
  }

  async promptInput(opts: BoxedInputOptions): Promise<string | null> {
    return this.store.getState().openInputModal(opts);
  }

  async promptApproval(
    decision: PermissionDecision,
    input: PermissionInput,
    opts: { signal?: AbortSignal; onCancel?: () => void } = {},
  ): Promise<ApprovalAnswer> {
    // `--dangerously-skip-permissions`: auto-approve instead of blocking on a
    // human, mirroring headless `approvalPolicy: "allow"`. Plan-mode denials
    // never reach here (they short-circuit in checkPermission), so the bypass
    // only covers tools that fall through to the engine's `ask`.
    if (this.store.getState().permissionMode === "bypassPermissions") return "always-allow";
    return this.store.getState().openApprovalModal(decision, input, opts);
  }

  async askUser(
    req: AskUserRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<AskUserResponse> {
    return this.store.getState().openAskModal(req, opts);
  }

  async pickOne<T>(opts: PickerOptions<T>): Promise<T | null> {
    if (opts.items.length === 0) return null;
    return this.store.getState().openPickModal(opts);
  }

  async pickHorizontal<T>(opts: HorizontalPickerOptions<T>): Promise<T | null> {
    if (opts.items.length === 0) return null;
    return this.store.getState().openPickHorizontalModal(opts);
  }

  /** Open a labelled 1-D "effort slider" (see {@link SliderPicker}). */
  async pickSlider<T>(opts: SliderPickerOptions<T>): Promise<T | null> {
    if (opts.items.length === 0) return null;
    return this.store.getState().openSliderModal(opts);
  }

  /**
   * Open a read-only, scrollable text pager. Resolves when the user closes it,
   * or — when `signal` is supplied — when that signal aborts (so a caller can
   * dismiss the pager programmatically on an external event).
   */
  async viewer(opts: ViewerOptions, o: { signal?: AbortSignal } = {}): Promise<void> {
    return this.store.getState().openViewerModal(opts, o.signal);
  }
}
