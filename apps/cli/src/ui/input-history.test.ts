import { describe, it, expect } from "vitest";
import { COMPACT_MARKER } from "@nova/context";
import type { MessageParam } from "@nova/core";
import { userInputHistory } from "./input-history.js";

describe("userInputHistory", () => {
  it("keeps plain-string user prompts in order, oldest first", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "second" },
    ];
    expect(userInputHistory(messages)).toEqual(["first", "second"]);
  });

  it("drops assistant messages", () => {
    const messages: MessageParam[] = [
      { role: "assistant", content: "I am the assistant" },
      { role: "assistant", content: [{ type: "text", text: "still me" }] },
    ];
    expect(userInputHistory(messages)).toEqual([]);
  });

  it("drops tool_result user messages (block-array content)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "real prompt" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
      },
    ];
    expect(userInputHistory(messages)).toEqual(["real prompt"]);
  });

  it("drops todo/task reminder and long-running notifier injections", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "do the thing" },
      { role: "user", content: [{ type: "text", text: "<reminder>Update your todos.</reminder>" }] },
      { role: "user", content: [{ type: "text", text: "<reminder>Update your tasks.</reminder>" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<long-running-command id="1" command="sleep" status="done">x</long-running-command>',
          },
        ],
      },
    ];
    expect(userInputHistory(messages)).toEqual(["do the thing"]);
  });

  it("drops the auto-compaction summary message", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "before compaction" },
      {
        role: "user",
        content: `[Conversation compacted ${COMPACT_MARKER}. Pre-compact transcript: /tmp/x.jsonl]\n\nsummary text`,
      },
      { role: "user", content: "after compaction" },
    ];
    expect(userInputHistory(messages)).toEqual(["before compaction", "after compaction"]);
  });
});
