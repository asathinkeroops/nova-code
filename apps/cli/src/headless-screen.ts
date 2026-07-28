import type { AskUserRequest, AskUserResponse } from "@nova/core";
import { Screen, type Spinner } from "./screen.js";
import type { PermissionMode } from "./permissions.js";

/** How headless answers permission prompts that would otherwise block on a human. */
export type HeadlessApprovalPolicy = "deny" | "allow";

export interface HeadlessScreenOptions {
  /** Permission mode reported to the engine; `auto` (the CLI default) when omitted. */
  permissionMode?: PermissionMode;
  /**
   * What to answer when a tool falls through to an interactive approval prompt.
   * "deny" (default) is safe: write/edit/bash get a denied tool_result and the
   * model reports the limitation. "allow" auto-approves — for unattended runs.
   */
  approvalPolicy?: HeadlessApprovalPolicy;
}

/**
 * A {@link Screen} with no terminal attached. Every state method (setMessages,
 * card, setBanner, getMessages, …) is inherited verbatim — they only mutate the
 * private zustand store, which renders nothing without `mount()`. We override
 * exactly the methods that would either drive Ink's lifecycle or block forever
 * waiting on human input.
 *
 * This lets `createContext` and the whole agent loop run unchanged in `-p`
 * (headless) mode: same hooks, same permission engine, same tool dispatch.
 */
export class HeadlessScreen extends Screen {
  private readonly mode: PermissionMode;
  private readonly approvalPolicy: HeadlessApprovalPolicy;

  constructor(opts: HeadlessScreenOptions = {}) {
    super();
    this.mode = opts.permissionMode ?? "auto";
    this.approvalPolicy = opts.approvalPolicy ?? "deny";
  }

  // ===== Ink lifecycle — no terminal, so these are inert. =====
  override mount(): void {}
  override async unmount(): Promise<void> {}
  override async reset(): Promise<void> {}

  // ===== Spinner — no live region to animate. =====
  override startSpinner(): Spinner {
    return { stop: () => {}, elapsedMs: () => 0, label: () => "working" };
  }

  // ===== Input — nothing types into a headless run. =====
  override takeInput(): Promise<string | null> {
    return Promise.resolve(null);
  }

  // ===== Permission — report the configured mode; never open a modal. =====
  override get interactive(): boolean {
    return false;
  }

  override getPermissionMode(): PermissionMode {
    return this.mode;
  }

  override async promptApproval(): Promise<"yes" | "no" | "always-allow"> {
    return this.approvalPolicy === "allow" ? "always-allow" : "no";
  }

  // ===== askUserQuestion — no human to answer; report cancellation so the
  // tool returns a clean "unanswered" result instead of hanging. =====
  override async askUser(req: AskUserRequest): Promise<AskUserResponse> {
    return {
      answers: req.questions.map(() => ({ selected: [] })),
      cancelled: true,
    };
  }
}
