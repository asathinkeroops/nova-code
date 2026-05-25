import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Rgb } from "../colors.js";
import type { AskUserRequest, AskUserResponse, MessageParam } from "@nova/core";
import type { Todo } from "@nova/orchestration";
import type { PermissionDecision, PermissionInput } from "@nova/safety";
import type { BannerProps } from "./banner.js";
import type { BoxedInputOptions } from "./input-box.js";
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
   * Canonical projection of the loop's MessageParam[]. Updated by the observer
   * on `messages_changed`, and directly by /clear and /resume. The `<Messages>`
   * component renders this; no other path should print conversation content.
   * The loop commits tool_results incrementally, so a pending tool_use simply
   * means "no matching tool_result block in this array yet."
   */
  messages: MessageParam[];
  /**
   * Inline UI entries (slash-command output, etc.) interleaved with `messages`
   * by the renderer. Purely client-side — never persisted to messages.jsonl
   * and never sent to the model. Cleared on /clear and on compact_end so they
   * never outlive the messages they were anchored to.
   */
  cards: Card[];
  todos: Todo[];
  spinner: SpinnerSpec | null;
  modal: ModalState | null;
  /**
   * Active turn interrupt handler. When set and no modal is open, the App
   * mounts an EscWatcher that calls this on Esc / Ctrl+C.
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
}

export interface AppActions {
  pushCard: (text: string, opts?: CardOptions) => void;
  clearCards: () => void;
  setBanner: (banner: BannerProps | null) => void;
  setMessages: (messages: MessageParam[]) => void;
  setThinkingLabel: (label: string | undefined) => void;
  setTodos: (todos: Todo[]) => void;
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
      spinner: null,
      modal: null,
      escHandler: null,
      thinkingLabel: undefined,
      setup: null,

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
        set({ messages: [], cards: [], spinner: null, modal: null });
        // banner and thinkingLabel intentionally preserved across reset —
        // banner tracks process-level state (model/session header),
        // thinkingLabel tracks user preference, neither is conversation state.
      },
    };
  });
}
