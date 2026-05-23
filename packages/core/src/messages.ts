import type {
  ContentBlock,
  MessageParam,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export function userText(text: string): MessageParam {
  return { role: "user", content: text };
}

export function assistantMessage(content: ContentBlock[]): MessageParam {
  return { role: "assistant", content };
}

export function userToolResults(results: ToolResultBlock[]): MessageParam {
  return { role: "user", content: results };
}

export function appendMessage(history: MessageParam[], next: MessageParam): MessageParam[] {
  return [...history, next];
}

export function blocksOf(message: MessageParam): ContentBlock[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return message.content;
}

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function extractToolUses(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function extractThinking(blocks: ContentBlock[]): ThinkingBlock[] {
  return blocks.filter((b): b is ThinkingBlock => b.type === "thinking");
}

export function serializeForTranscript(message: MessageParam): MessageParam {
  return JSON.parse(JSON.stringify(message)) as MessageParam;
}
