import { describe, expect, it } from "vitest";
import { markSynthetic, type MessageParam } from "@nova/core";
import { replayableMessages } from "./headless.js";

const user = (content: string): MessageParam => ({ role: "user", content });
const assistant = (text: string): MessageParam => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("replayableMessages", () => {
  it("keeps ordinary user/assistant messages", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(replayableMessages(messages)).toEqual(messages);
  });

  it("drops nova injections, including the skills index", () => {
    const messages = [
      user("hi"),
      markSynthetic(
        {
          role: "user",
          content: "<available-skills>\n- alpha: Alpha\n</available-skills>",
        },
        "skills-index",
        "v1",
      ),
      markSynthetic(
        { role: "user", content: "<todo-reminder>Update your todos.</todo-reminder>" },
        "todo-reminder",
      ),
      markSynthetic(
        { role: "user", content: "<plan-mode>Plan mode is now ON.</plan-mode>" },
        "plan-mode",
      ),
      assistant("done"),
    ];
    expect(replayableMessages(messages).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps execution evidence: monitor, background and shell-escape", () => {
    const messages = [
      user("hi"),
      markSynthetic(
        {
          role: "user",
          content:
            '<monitor-notification id="m1">build-42 finished with exit code 1</monitor-notification>',
        },
        "monitor-notification",
      ),
      markSynthetic(
        {
          role: "user",
          content:
            '<background-notification id="b1" status="failed">failed</background-notification>',
        },
        "background-notification",
      ),
      markSynthetic(
        { role: "user", content: "<shell-escape>diff --git a/x b/x</shell-escape>" },
        "shell-escape",
      ),
      assistant("done"),
    ];
    expect(replayableMessages(messages)).toEqual(messages);
  });

  it("drops internal control prompts", () => {
    const messages = [
      user("hi"),
      markSynthetic(
        { role: "user", content: "<interrupted>cancelled</interrupted>" },
        "interrupted",
      ),
      markSynthetic({ role: "user", content: "<goal-eval>still failing</goal-eval>" }, "goal-eval"),
      markSynthetic(
        { role: "user", content: "Continue from where you left off." },
        "max-tokens-continuation",
      ),
    ];
    expect(replayableMessages(messages)).toEqual([messages[0]]);
  });

  it("keeps the compaction boundary so the model view stays replayable", () => {
    const boundary = markSynthetic(
      { role: "user", content: "<compacted>\nsummary\n</compacted>" },
      "compacted",
    );
    const messages = [user("hi"), boundary, user("next")];
    expect(replayableMessages(messages)).toEqual(messages);
  });

  it("does not filter on the in-band tag (a typed <available-skills> stays)", () => {
    const typed = user("<available-skills>\n- alpha: Alpha\n</available-skills>");
    expect(replayableMessages([typed])).toEqual([typed]);
  });
});
