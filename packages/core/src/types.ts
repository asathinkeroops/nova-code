import { z } from "zod";

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
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
  content: z.union([z.string(), z.array(textBlockSchema)]),
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
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
]);

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof redactedThinkingBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const messageParamSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
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

export interface AskUserQuestionSpec {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
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

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  askUser?: AskUserFn;
  fileLedger?: FileAccessLedger;
}

export interface ToolHandler {
  definition: ToolDefinition;
  run(input: unknown, ctx: ToolContext): Promise<ToolRunResult>;
}

export interface ToolRunResult {
  output: string;
  isError?: boolean;
}

export type ToolExecutor = (
  toolUse: ToolUseBlock,
  ctx: ToolContext,
) => Promise<ToolResultBlock>;

export interface PermissionResult {
  granted: boolean;
  reason?: string;
}
