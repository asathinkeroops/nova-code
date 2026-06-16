import React from "react";
import { render } from "ink";
import type {
  AskUserRequest,
  AskUserResponse,
  MessageParam,
} from "@nova/core";
import type { Task, Todo } from "@nova/tools";
import type { ModelRates } from "@nova/observability";
import type { AccountBalance } from "./deepseek-balance.js";
import type { SubAgentDetail } from "@nova/subagent";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { App } from "./ui/app.js";
import { type ApprovalAnswer } from "./ui/approval.js";
import { type BannerProps } from "./ui/render-item.js";
import { type BoxedInputOptions, type SlashCommand } from "./ui/input-box.js";
import { copyToClipboard } from "./ui/clipboard.js";
import { attachFilteredStdin } from "./ui/mouse.js";
import { extractSelection } from "./ui/selection.js";
import { type SetupEntry, type SetupState } from "./ui/setup-view.js";
import { type PermissionMode } from "./permissions.js";
import {
  type HorizontalPickerOptions,
  type PickerOptions,
  type ViewerOptions,
} from "./ui/picker.js";
import {
  createAppStore,
  type AppStoreApi,
  type CardOptions,
  type SpinnerHandle,
  type SpinnerLabel,
} from "./ui/store.js";

export type { SpinnerLabel } from "./ui/store.js";
export type Spinner = SpinnerHandle;

/**
 * Tear down Ink and exit with `message` on stderr. Used by start-up failures
 * and fatal mid-session errors — anything that needs to surface a message
 * the user can still see after Ink releases the terminal. Writing to stderr
 * AFTER unmount avoids interleaving with Ink's live-region paint.
 */
export async function fatalExit(
  screen: Screen,
  message: string,
  code: number = 2,
): Promise<never> {
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
export class Screen {
  private store: AppStoreApi = createAppStore();
  private instance: InkInstance | null = null;
  private mounted = false;
  private detachResize: (() => void) | null = null;
  private detachMouse: (() => void) | null = null;
  private detachAltScreen: (() => void) | null = null;

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
    // screen), so visibleLines index = row - 1. Selection state lives in
    // 0-indexed viewport coords for direct use during render.
    const filtered = attachFilteredStdin({
      onWheel: ({ delta }) => this.store.getState().scrollBy(delta),
      onSelectStart: ({ row, col }) => {
        const r = Math.max(0, row - 1);
        const c = Math.max(0, col - 1);
        this.store.getState().setSelection({
          startRow: r,
          startCol: c,
          endRow: r,
          endCol: c,
        });
      },
      onSelectUpdate: ({ row, col }) => {
        const cur = this.store.getState().selection;
        if (!cur) return;
        this.store.getState().setSelection({
          ...cur,
          endRow: Math.max(0, row - 1),
          endCol: Math.max(0, col - 1),
        });
      },
      onSelectEnd: ({ row, col }, moved) => {
        const state = this.store.getState();
        const cur = state.selection;
        state.setSelection(null);
        if (!moved || !cur) return;
        const lines = state.visibleLines;
        if (lines.length === 0) return;
        const text = extractSelection(lines, {
          startRow: cur.startRow,
          startCol: cur.startCol,
          endRow: Math.max(0, row - 1),
          endCol: Math.max(0, col - 1),
        }).trim();
        if (text.length === 0) return;
        if (copyToClipboard(text)) {
          const lineCount = text.split("\n").length;
          state.setCopyNotice(
            `✓ copied ${lineCount} line${lineCount === 1 ? "" : "s"} to clipboard`,
          );
        }
      },
    });
    this.detachMouse = filtered.detach;

    this.instance = render(React.createElement(App, { store: this.store }), {
      stdin: filtered.stream,
      exitOnCtrlC: false,
    }) as InkInstance;
    this.mounted = true;

    // Re-show the cursor after Ink's first paint hid it via cli-cursor.
    // Ink's log-update only hides once (gated by an internal `hasHiddenCursor`
    // flag), so a one-time re-show is enough — Ink will not re-hide on later
    // frames. A visible cursor anchors IME composition popups (Chinese / JP /
    // etc.) to the actual typing row instead of defaulting to row 1 col 1.
    setImmediate(() => {
      if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
    });

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
    this.store.getState().pushCard(text, opts);
  }

  clearCards(): void {
    this.store.getState().clearCards();
  }

  setBanner(banner: BannerProps | null): void {
    this.store.getState().setBanner(banner);
  }

  setStatusMeta(meta: {
    sessionStartedAt: number;
    gitBranch: string | null;
    contextWindowTokens: number;
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

  /** Wake an idle REPL for a background continuation (see store `wake`). */
  wake(): void {
    this.store.getState().wake();
  }

  setSlashCommands(commands: SlashCommand[]): void {
    this.store.getState().setSlashCommands(commands);
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

  /** Advance to the next permission mode; returns the new one. */
  cyclePermissionMode(): PermissionMode {
    return this.store.getState().cyclePermissionMode();
  }

  /** Seed the initial permission mode (e.g. from the `--permission-mode` flag). */
  setPermissionMode(mode: PermissionMode): void {
    this.store.getState().setPermissionMode(mode);
  }

  /**
   * Enable/disable the auto-approve bypass (`--dangerously-skip-permissions`).
   * When on, `promptApproval` resolves to `always-allow` without opening a modal.
   */
  setSkipPermissions(value: boolean): void {
    this.store.getState().setSkipPermissions(value);
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

  startSpinner(label: SpinnerLabel, hint?: string): SpinnerHandle {
    return this.store.getState().startSpinner(label, hint);
  }

  setEscHandler(fn: (() => void) | null): void {
    this.store.getState().setEscHandler(fn);
  }

  beginSetup(state: SetupState): void {
    this.store.getState().beginSetup(state);
  }

  setSetupPrompt(prompt: { label: string; hint: string } | null): void {
    this.store.getState().setSetupPrompt(prompt);
  }

  pushSetupEntry(entry: SetupEntry): void {
    this.store.getState().pushSetupEntry(entry);
  }

  endSetup(): void {
    this.store.getState().endSetup();
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
    if (this.store.getState().skipPermissions) return "always-allow";
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

  /** Open a read-only, scrollable text pager. Resolves when the user closes it. */
  async viewer(opts: ViewerOptions): Promise<void> {
    return this.store.getState().openViewerModal(opts);
  }
}

