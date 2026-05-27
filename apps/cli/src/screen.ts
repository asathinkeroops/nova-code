import React from "react";
import { render } from "ink";
import type {
  AskUserRequest,
  AskUserResponse,
  MessageParam,
} from "@nova/core";
import type { Task, Todo } from "@nova/tools";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { App } from "./ui/app.js";
import { type ApprovalAnswer } from "./ui/approval.js";
import { type BannerProps } from "./ui/banner.js";
import { type BoxedInputOptions } from "./ui/input-box.js";
import { type SetupEntry, type SetupState } from "./ui/setup-view.js";
import {
  type HorizontalPickerOptions,
  type PickerOptions,
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
 * TTY is required — the entry point (`index.ts`) refuses to start in
 * non-TTY mode, so `mount()` can assume Ink will work. The one exception
 * is `--list-sessions`, which is a non-interactive query that bypasses
 * Screen entirely and dumps straight to stdout.
 */
export class Screen {
  private store: AppStoreApi = createAppStore();
  private instance: InkInstance | null = null;
  private mounted = false;

  mount(): void {
    if (this.mounted) return;
    this.instance = render(React.createElement(App, { store: this.store }), {
      exitOnCtrlC: false,
    }) as InkInstance;
    this.mounted = true;
  }

  async unmount(): Promise<void> {
    if (!this.mounted || !this.instance) return;
    const inst = this.instance;
    this.instance = null;
    this.mounted = false;
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
  }

  /**
   * Tear down the Ink tree, clear the terminal, and remount a fresh tree.
   * Used by /clear and /resume to drop any content the terminal has already
   * scrolled past, so the loaded history (or empty post-clear state) starts
   * at the top of a fresh screen.
   */
  async reset(): Promise<void> {
    await this.unmount();
    process.stdout.write("\x1b[2J\x1b[H");
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

  setTodos(todos: Todo[]): void {
    this.store.getState().setTodos(todos);
  }

  setTasks(tasks: Task[]): void {
    this.store.getState().setTasks(tasks);
  }

  setMessages(messages: MessageParam[]): void {
    this.store.getState().setMessages(messages);
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
}
