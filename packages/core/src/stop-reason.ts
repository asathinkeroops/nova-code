import type { StopReason } from "./types.js";

export type StopDecision =
  | { kind: "continue" }
  | { kind: "return"; reason: StopReason }
  /**
   * The response was cut off by the per-response output cap. The loop MAY
   * re-prompt the model to continue (bounded by `maxTokensContinuations`);
   * if continuation is disabled or exhausted it falls back to `message` as a
   * terminating error — same surface as `kind: "error"`.
   */
  | { kind: "truncated"; reason: StopReason; message: string }
  | { kind: "error"; reason: StopReason; message: string };

export function decide(reason: StopReason): StopDecision {
  switch (reason) {
    case "tool_use":
      return { kind: "continue" };
    case "end_turn":
      return { kind: "return", reason };
    case "pause_turn":
      return { kind: "continue" };
    case "max_tokens":
      return {
        kind: "truncated",
        reason,
        message:
          "Model hit max_tokens before finishing. Increase maxTokens, raise maxTokensContinuations, or have the model produce a shorter response.",
      };
    case "stop_sequence":
      return { kind: "return", reason };
    case "refusal":
      return {
        kind: "error",
        reason,
        message: "Model refused to respond — safety classifier triggered.",
      };
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unhandled stop_reason: ${String(exhaustive)}`);
    }
  }
}
