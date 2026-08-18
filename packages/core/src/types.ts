import { z } from "zod";

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string(),
  }),
});

export const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([textBlockSchema, imageBlockSchema]))]),
  is_error: z.boolean().optional(),
});

// Extended-thinking blocks returned by the API. Must be round-tripped verbatim
// (signature is used by Anthropic to verify the block was not tampered with).
export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string(),
});

export const redactedThinkingBlockSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
]);

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof redactedThinkingBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

/**
 * Which nova injection produced a synthetic message. This is the OUT-OF-BAND
 * source of truth for "not typed by the user / not model output": the TUI hides
 * these bubbles and the compaction slice finds its boundary by reading `kind`
 * here — NOT by string-matching the in-band `<...>` tag (which a user could type
 * verbatim, colliding with a real boundary). The in-band tag still lives in
 * `content` for the model to read; `meta` is the additive structural marker.
 */
export const syntheticKindSchema = z.enum([
  "todo-reminder",
  "task-reminder",
  "background-notification",
  "monitor-notification",
  "plan-mode",
  "plan-approved",
  "interrupted",
  "goal-eval",
  "shell-escape",
  "compacted",
]);

export type SyntheticKind = z.infer<typeof syntheticKindSchema>;

/**
 * Renamed `kind` values → their current name. `kind` is PERSISTED in
 * `messages.jsonl`, so dropping an old value from the enum would make every
 * session that contains it fail to parse — taking the whole transcript with it,
 * not just the one message. Renames therefore have to land here as well.
 */
const RENAMED_KINDS: Readonly<Record<string, SyntheticKind>> = {
  "background-notifier": "background-notification",
};

/**
 * Rewrite a legacy `kind` before validation, so sessions written under the old
 * name still load. Applied via `preprocess` rather than at the one call site
 * that loads transcripts, so EVERY parse path is covered.
 */
export const messageMetaSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const meta = raw as { kind?: unknown };
    if (typeof meta.kind !== "string") return raw;
    const renamed = RENAMED_KINDS[meta.kind];
    return renamed ? { ...meta, kind: renamed } : raw;
  },
  z.object({
    synthetic: z.literal(true),
    kind: syntheticKindSchema,
  }),
);

export type MessageMeta = z.infer<typeof messageMetaSchema>;

export const messageParamSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
  /**
   * Present only on nova-injected messages (see `messageMetaSchema`). Kept in
   * canonical history + persisted to disk, but STRIPPED before the request
   * reaches the model gateway (see `toWireMessages`) so it never perturbs the
   * prefix cache.
   */
  meta: messageMetaSchema.optional(),
});

export type MessageParam = z.infer<typeof messageParamSchema>;

export const stopReasonSchema = z.enum([
  "end_turn",
  "pause_turn",
  "max_tokens",
  "stop_sequence",
  "refusal",
  "tool_use",
]);

export type StopReason = z.infer<typeof stopReasonSchema>;

export interface AssistantTurn {
  content: ContentBlock[];
  stopReason: StopReason;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /**
   * Pre-built JSON Schema for the tool's input, used verbatim as the wire
   * `input_schema` sent to the model instead of deriving one from `inputSchema`
   * via zod-to-json-schema. Tools that originate outside the type system —
   * notably MCP servers, which publish native JSON Schema — set this so their
   * schema reaches the model losslessly; `inputSchema` then only needs to be a
   * permissive validator (server-side validation is authoritative). Plain data,
   * so core stays model-agnostic.
   */
  inputJsonSchema?: Record<string, unknown>;
}

/** What a {@link ToolPromptSection} may look at when it renders. */
export interface ToolPromptContext {
  /**
   * Tool names present in the snapshot this block is being rendered for —
   * already past the host's denylist and, for a sub-agent, past its
   * `readOnly` / `allowTools` filter.
   */
  present: ReadonlySet<string>;
}

/**
 * A chunk of system-prompt text that only makes sense when certain tools are
 * in play — the todo discipline, the background-vs-monitor tradeoff, the skills
 * index. Sections are declared NEXT TO the tools they describe (a tool family's
 * factory exports its own) and gathered by the host, which owns the final tool
 * set.
 *
 * Deliberately N:M with tools, not 1:1 — one section usually spans a whole
 * family, and cross-tool guidance ("use X, not Y") belongs to neither tool
 * alone. Per-tool "how to call this" text stays in `ToolDefinition.description`,
 * which travels with the schema and tracks the live registry.
 *
 * ── TWO RULES, BOTH LOAD-BEARING ───────────────────────────────────────────
 *
 * 1. `render` must be PURE and BYTE-DETERMINISTIC: the same tool set must
 *    always produce the same bytes. The result lands in the system prompt,
 *    which is byte 0 of the request prefix and frozen for an epoch
 *    (`freezeSystemPrompt`) — a section that varies renders the freeze into a
 *    silent no-op and, without it, would collapse the prefix cache.
 * 2. A section reads the tool set SNAPSHOT it is handed, never live state. The
 *    block is rendered once per epoch; anything that changes mid-session
 *    (an MCP server disconnecting, a skill installed by `/plugin`) does not
 *    reach it until the next session boundary. Guidance that genuinely has to
 *    react mid-turn belongs in an injected message (`pre_request`) instead.
 */
export interface ToolPromptSection {
  /** Stable dedup key — `"todo"`, `"skills"`. Later duplicates are dropped. */
  id: string;
  /** Ascending; ties keep input order. Default 100. */
  order?: number;
  /** Emit only when EVERY name is present. */
  requires?: readonly string[];
  /** Emit only when AT LEAST ONE name is present. Combined with `requires` via AND. */
  requiresAny?: readonly string[];
  /** The section's text. Return `""` to emit nothing. */
  render(ctx: ToolPromptContext): string;
}

export interface AskUserQuestionSpec {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  /**
   * Whether the UI appends an "Other" option that lets the user type a freeform
   * answer. Defaults to true (the model-facing askUserQuestion tool relies on
   * it). Set false for internal yes/no style prompts where a custom answer makes
   * no sense — e.g. the sandbox re-run confirmation.
   */
  allowFreeform?: boolean;
}

export interface AskUserRequest {
  questions: AskUserQuestionSpec[];
}

export interface AskUserAnswer {
  selected: string[];
  freeform?: string;
}

export interface AskUserResponse {
  answers: AskUserAnswer[];
  cancelled?: boolean;
}

export type AskUserFn = (req: AskUserRequest) => Promise<AskUserResponse>;

/**
 * Session-scoped file access ledger used by tool invariants (read-before-edit,
 * mtime drift). The loop itself never touches it — it's threaded through
 * ToolContext so the dispatcher's invariants layer can read/write entries.
 * Typed as an opaque interface so @nova/core stays implementation-agnostic.
 */
export interface FileAccessLedger {
  recordRead(absPath: string, mtimeMs: number): void;
  recordWrite(absPath: string, mtimeMs: number): void;
  get(absPath: string): { lastReadMtimeMs: number } | undefined;
}

/** A refused tool call, with a model-readable reason for the refusal. */
export interface InvariantViolation {
  ok: false;
  message: string;
}

/**
 * The invariants gate the dispatcher consults around every tool call:
 * `preCheck` runs after schema validation and may refuse the call (the
 * dispatcher turns a violation into an `is_error` tool_result rather than a
 * throw, so the model can read the reason and correct itself); `postCommit`
 * runs after a successful run so the gate can record what changed.
 *
 * Declared here, next to `FileAccessLedger`, for the same reason: it is the
 * contract between the dispatcher and whatever enforces it. The enforcement
 * itself — read-before-edit and mtime-drift — lives in `@nova/safety`
 * alongside the permission engine, so `@nova/tools` never depends on it.
 */
export interface InvariantsCheck {
  preCheck(use: ToolUseBlock, ctx: ToolContext): Promise<{ ok: true } | InvariantViolation>;
  postCommit(use: ToolUseBlock, ctx: ToolContext, isError: boolean): Promise<void>;
}

/**
 * Optional OS-level sandbox bridge. When present on a ToolContext, tools that
 * spawn a subprocess (bash, foreground and run_in_background alike) route their command through
 * `wrapCommand` before spawning, so it executes inside the platform sandbox
 * (macOS Seatbelt / Linux bubblewrap). Injected by the CLI; @nova/core and
 * @nova/tools never import the sandbox SDK directly, keeping those layers
 * model/SDK-agnostic. The bridge fails open: when sandboxing is inactive
 * (disabled, unsupported platform, missing host deps), `wrapCommand` returns
 * the command unchanged.
 */
export interface SandboxBridge {
  /** Wrap a shell command so it runs inside the sandbox, or return it unchanged when inactive. */
  wrapCommand(command: string, signal?: AbortSignal): Promise<string>;
  /**
   * Signal that a wrapped command has finished, so the sandbox can release any
   * per-command resources (Linux bubblewrap mount points; a no-op on macOS).
   * Call once after a command spawned via `wrapCommand` completes. Reference-
   * counted, so it is safe to call while other sandboxed commands are still
   * running. Detached/background commands may skip it — `dispose()` force-
   * cleans everything at session end.
   */
  afterCommand(): void;
  /**
   * Append any sandbox-violation context recorded for `command` to its output,
   * so a denied write surfaces as a readable reason rather than a bare EPERM.
   * Returns `output` unchanged when there are no violations / monitoring is off.
   */
  annotateOutput(command: string, output: string): string;
  /**
   * Sandbox-violation lines captured for `command` since it ran — the OS
   * sandbox's filesystem/network denials. Empty when monitoring is off
   * (`settings.sandbox.monitorViolations: false`), the sandbox is inactive, or
   * the command tripped no violations. Lets a tool distinguish a failure
   * *caused by* sandbox confinement from the command's own non-zero exit, and
   * offer to re-run it unsandboxed.
   */
  violationsForCommand(command: string): string[];
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  askUser?: AskUserFn;
  fileLedger?: FileAccessLedger;
  sandbox?: SandboxBridge;
  /**
   * The `id` of the `tool_use` block driving this call. Injected per-call by
   * the dispatcher (the shared turn-level context carries no per-use identity).
   * Lets a tool key out-of-band, display-only state to its own invocation —
   * e.g. the sub-agent tool tags streamed thinking/tool-use details so the UI
   * can attach them to the right tool-call card and survive `/resume`.
   */
  toolUseId?: string;
  /**
   * The active model's input modalities. Read tools consult this to decide
   * whether to return image content; when unset or missing "image", image
   * files fall back to the text reader (current behavior).
   */
  modelModalities?: { input: readonly ("text" | "image")[] };
  /**
   * Id of the session this call belongs to. Surfaced to authored content that
   * needs to name the run — e.g. `${CLAUDE_SESSION_ID}` in a SKILL.md. Optional
   * because library consumers may drive tools without a session.
   */
  sessionId?: string;
  /**
   * Current reasoning-effort level (nova's thinking level: off/low/medium/
   * high/max). Surfaced to authored content as `${CLAUDE_EFFORT}`; changes
   * within a session via `/effort`, so it is read per call, never captured.
   */
  effort?: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  run(input: unknown, ctx: ToolContext): Promise<ToolRunResult>;
}

export interface ToolRunResult {
  output: string;
  isError?: boolean;
  /**
   * Optional structured content blocks (images, etc.) that accompany the text
   * output. When present, the dispatcher emits them alongside a wrapping text
   * block derived from `output` — the model sees the text metadata first, then
   * the rich content. Only text and image blocks are valid inside a tool_result;
   * tool_use / thinking blocks are not.
   */
  blocks?: (TextBlock | ImageBlock)[];
}

export type ToolExecutor = (toolUse: ToolUseBlock, ctx: ToolContext) => Promise<ToolResultBlock>;

export interface PermissionResult {
  granted: boolean;
  reason?: string;
}
