import React from "react";
import { render } from "ink";
import type {
  AskUserRequest,
  AskUserResponse,
  MessageParam,
} from "@nova/core";
import type { Todo } from "@nova/orchestration";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import { App } from "./ui/app.js";
import { type ApprovalAnswer } from "./ui/approval.js";
import { type BoxedInputOptions } from "./ui/input-box.js";
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

interface InkInstance {
  unmount(): void;
  waitUntilExit(): Promise<void>;
  clear(): void;
  rerender(node: React.ReactElement): void;
}

/**
 * Single owner of the terminal UI. Wraps an Ink render at the bottom that
 * keeps the live region (spinner / footer / modals) anchored, while past
 * output flows above via Static.
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
   * Used by /clear and /resume since `<Static>` is append-only.
   */
  async reset(): Promise<void> {
    await this.unmount();
    process.stdout.write("\x1b[2J\x1b[H");
    this.store.getState().reset();
    this.mount();
  }

  print(text: string): void {
    if (text.length === 0) return;
    this.store.getState().print(text);
  }

  /**
   * Push a React node into the Static history. Used for things that benefit
   * from Ink layout primitives (banner, etc.).
   */
  printNode(node: React.ReactNode): void {
    this.store.getState().printNode(node);
  }

  printErr(text: string): void {
    if (text.length === 0) return;
    // Route stderr-class output into the same scroll history so it stays
    // in order with surrounding stdout.
    this.store.getState().print(text);
  }

  /**
   * Push an inline card into the conversation timeline. Cards render between
   * messages at the position they were pushed and are dropped on /clear and
   * compact_end — they never enter the model context or messages.jsonl.
   */
  card(text: string, opts: CardOptions = {}): void {
    if (text.length === 0 && !opts.title) return;
    this.store.getState().pushCard(text, opts);
  }

  clearCards(): void {
    this.store.getState().clearCards();
  }

  setTodos(todos: Todo[]): void {
    this.store.getState().setTodos(todos);
  }

  setMessages(messages: MessageParam[]): void {
    this.store.getState().setMessages(messages);
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

  async promptInput(opts: BoxedInputOptions): Promise<string | null> {
    const state = this.store.getState();
    const value = await state.openInputModal(opts);
    if (value !== null && opts.mask) {
      // For masked input (passwords / API keys), echo a fixed-width placeholder
      // so the user still sees that *something* was submitted. Non-masked input
      // is echoed by the caller (REPL for slash commands, runTurn via Messages
      // for user prompts) so that visibility stays consistent across both
      // live and resumed sessions.
      this.store.getState().print(`› ${"*".repeat(value.length)}\n`);
    }
    return value;
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
