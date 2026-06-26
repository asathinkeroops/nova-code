import type { MessageParam } from "@nova/core";
import { describe, expect, it } from "vitest";
import type { RenderItem } from "./render-item.js";
import { buildLiveDraftItems, buildRenderItems } from "./render-item.js";
import { renderItemToString } from "./render-strings.js";

describe("buildLiveDraftItems", () => {
  it("emits reasoning then the answer, each with a leading spacer", () => {
    const items = buildLiveDraftItems({ text: "answer", thinking: "reason" }, "high");
    expect(items.map((i) => i.kind)).toEqual(["spacer", "thinking", "spacer", "assistant-text"]);
    const th = items.find((i) => i.kind === "thinking");
    expect(th).toMatchObject({ thinking: "reason", label: "high" });
    const at = items.find((i) => i.kind === "assistant-text");
    expect(at).toMatchObject({ text: "answer" });
  });

  it("omits the thinking section when there's no reasoning", () => {
    const items = buildLiveDraftItems({ text: "answer", thinking: "" });
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text"]);
  });

  it("omits the answer section when only reasoning has streamed", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    expect(items.map((i) => i.kind)).toEqual(["spacer", "thinking"]);
  });

  it("returns nothing for an empty/whitespace draft", () => {
    expect(buildLiveDraftItems({ text: "", thinking: "" })).toEqual([]);
    expect(buildLiveDraftItems({ text: "   ", thinking: "\n" })).toEqual([]);
  });

  it("leaves the thinking label off when none is given", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    const th = items.find((i) => i.kind === "thinking");
    expect(th && "label" in th ? th.label : undefined).toBeUndefined();
  });

  it("does not collapse live (still-streaming) thinking", () => {
    const items = buildLiveDraftItems({ text: "", thinking: "reason" });
    const th = items.find((i) => i.kind === "thinking");
    expect(th && th.kind === "thinking" ? th.collapsed : undefined).toBeFalsy();
  });
});

describe("buildRenderItems committed thinking", () => {
  const render = (content: MessageParam["content"]) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content }],
    });

  it("renders a thinking block that carries reasoning", () => {
    const items = render([
      { type: "thinking", thinking: "reasoned", signature: "sig" },
      { type: "text", text: "answer" },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "spacer",
      "thinking",
      "spacer",
      "assistant-text",
    ]);
  });

  it("marks committed thinking as collapsed (it is done)", () => {
    const items = render([{ type: "thinking", thinking: "reasoned", signature: "sig" }]);
    const th = items.find((i) => i.kind === "thinking");
    expect(th).toMatchObject({ collapsed: true });
  });

  it("skips an empty thinking block (no dangling header)", () => {
    const items = render([
      { type: "thinking", thinking: "", signature: "" },
      { type: "text", text: "answer" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text"]);
    expect(items.some((i) => i.kind === "thinking")).toBe(false);
  });

  it("still renders a redacted_thinking block (encrypted reasoning exists)", () => {
    const items = render([
      { type: "redacted_thinking", data: "enc" },
      { type: "text", text: "answer" },
    ]);
    expect(items.some((i) => i.kind === "redacted-thinking")).toBe(true);
  });
});

describe("buildRenderItems block ordering", () => {
  const render = (content: MessageParam["content"]) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content }],
    });

  const bash = (id: string) => ({
    type: "tool_use" as const,
    id,
    name: "bash",
    input: { command: "ls" },
  });

  it("renders narration text before the tool calls it introduces", () => {
    const items = render([
      { type: "text", text: "Let me check the deps." },
      bash("t1"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "assistant-text", "spacer", "tool-call"]);
  });

  it("preserves text -> tool -> text interleaving as separate items", () => {
    const items = render([
      { type: "text", text: "first" },
      bash("t1"),
      { type: "text", text: "second" },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "spacer",
      "assistant-text",
      "spacer",
      "tool-call",
      "spacer",
      "assistant-text",
    ]);
    const texts = items.filter((i) => i.kind === "assistant-text");
    expect(texts.map((t) => (t.kind === "assistant-text" ? t.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("skips empty text blocks on a pure tool-call turn", () => {
    const items = render([{ type: "text", text: "" }, bash("t1")]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-call"]);
  });
});

describe("buildRenderItems hides system-injected user messages", () => {
  const firstUserText = (content: string) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content }],
    }).find((i) => i.kind === "user-text");

  it("renders a real typed prompt as a user bubble", () => {
    expect(firstUserText("real prompt")).toMatchObject({ text: "real prompt" });
  });

  it.each([
    "<reminder>Update your todos.</reminder>",
    '<background-command id="1" status="done">x</background-command>',
    "<interrupted-by-user></interrupted-by-user>",
    "<goal-eval>\nYour goal is not complete yet. Evaluation: tests fail\n</goal-eval>",
    "<compacted>\n[Conversation compacted [compacted].]\n\nSUMMARY OF WORK\n</compacted>",
  ])("skips the bubble for injection %#", (content) => {
    expect(firstUserText(content)).toBeUndefined();
  });
});

describe("buildRenderItems user display overrides", () => {
  const userText = (overrides?: Record<string, string>) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content: "EXPANDED model prompt" }],
      ...(overrides ? { userDisplayOverrides: overrides } : {}),
    }).find((i) => i.kind === "user-text");

  it("shows the original input when the message text matches an override key", () => {
    expect(userText({ "EXPANDED model prompt": "/agent reviewer audit foo.ts" })).toMatchObject(
      { text: "/agent reviewer audit foo.ts" },
    );
  });

  it("falls back to the raw message text when there is no override", () => {
    expect(userText()).toMatchObject({ text: "EXPANDED model prompt" });
    expect(userText({ "some other key": "x" })).toMatchObject({ text: "EXPANDED model prompt" });
  });

  it("applies overrides to text blocks too, not just string content", () => {
    const item = buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "user", content: [{ type: "text", text: "EXPANDED" }] }],
      userDisplayOverrides: { EXPANDED: "/plan ship it" },
    }).find((i) => i.kind === "user-text");
    expect(item).toMatchObject({ text: "/plan ship it" });
  });
});

describe("buildRenderItems sub-agent details", () => {
  const subagentUse = {
    type: "tool_use" as const,
    id: "sub-1",
    name: "createSubAgent",
    input: { description: "audit", type: "explore", prompt: "look" },
  };
  const toolCall = (toolDetails?: Record<string, import("@nova/subagent").SubAgentDetail[]>) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [{ role: "assistant", content: [subagentUse] }],
      ...(toolDetails ? { toolDetails } : {}),
    }).find((i) => i.kind === "tool-call");

  it("attaches details to the matching tool-call item by tool_use id", () => {
    const item = toolCall({
      "sub-1": [
        { type: "thinking", text: "planning" },
        { type: "final", text: "done" },
      ],
    });
    expect(item).toMatchObject({
      details: [
        { type: "thinking", text: "planning" },
        { type: "final", text: "done" },
      ],
    });
  });

  it("omits details when none are recorded for the tool_use id", () => {
    expect(toolCall()).not.toHaveProperty("details");
    expect(toolCall({ "other-id": [{ type: "final", text: "x" }] })).not.toHaveProperty(
      "details",
    );
  });
});

describe("buildRenderItems tool batching", () => {
  const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "tool_use" as const,
    id,
    name,
    input,
  });
  const toolResult = (id: string, text: string, isError = false) => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content: text,
    ...(isError ? { is_error: true } : {}),
  });

  // One assistant message of tool_use blocks paired with a following user
  // message of their tool_results — mirrors how the loop commits them.
  const render = (
    uses: ReturnType<typeof toolUse>[],
    results: ReturnType<typeof toolResult>[],
    expandedItems?: Record<string, boolean>,
  ) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [
        { role: "assistant", content: uses },
        { role: "user", content: results },
      ],
      ...(expandedItems ? { expandedItems } : {}),
    });

  it("folds two adjacent completed reads into a collapsed tool-batch", () => {
    const items = render(
      [toolUse("r1", "read", { path: "a.ts" }), toolUse("r2", "read", { path: "b.ts" })],
      [toolResult("r1", "x"), toolResult("r2", "y")],
    );
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-batch"]);
    const batch = items.find((i) => i.kind === "tool-batch");
    expect(batch).toMatchObject({ key: "r1", collapsed: true });
    expect(batch && batch.kind === "tool-batch" ? batch.members.length : 0).toBe(2);
  });

  it("leaves a lone tool call as a normal tool-call item", () => {
    const items = render([toolUse("r1", "read", { path: "a.ts" })], [toolResult("r1", "x")]);
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-call"]);
  });

  it("batches pending calls too, so the line stays stable while results stream", () => {
    const items = render(
      [toolUse("r1", "read", { path: "a.ts" }), toolUse("r2", "read", { path: "b.ts" })],
      [toolResult("r1", "x")], // r2 has no result yet
    );
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-batch"]);
    const batch = items.find((i) => i.kind === "tool-batch");
    expect(batch && batch.kind === "tool-batch" ? batch.members.length : 0).toBe(2);
    // The still-pending member is carried with an undefined result.
    expect(
      batch && batch.kind === "tool-batch" ? batch.members[1]?.result : "x",
    ).toBeUndefined();
  });

  it("expands a batch whose key is in expandedItems", () => {
    const items = render(
      [toolUse("r1", "read", { path: "a.ts" }), toolUse("r2", "read", { path: "b.ts" })],
      [toolResult("r1", "x"), toolResult("r2", "y")],
      { r1: true },
    );
    const batch = items.find((i) => i.kind === "tool-batch");
    expect(batch).toMatchObject({ collapsed: false });
  });

  it("batches a mix of search / read / run but not other tools", () => {
    const items = render(
      [
        toolUse("g1", "grep", { pattern: "x" }),
        toolUse("r1", "read", { path: "a.ts" }),
        toolUse("b1", "bash", { command: "ls" }),
      ],
      [toolResult("g1", "m"), toolResult("r1", "x"), toolResult("b1", "out")],
    );
    expect(items.map((i) => i.kind)).toEqual(["spacer", "tool-batch"]);
    // An edit between two reads breaks the run into two single calls.
    const split = render(
      [
        toolUse("r1", "read", { path: "a.ts" }),
        toolUse("e1", "edit", { path: "a.ts", old_string: "x", new_string: "y" }),
        toolUse("r2", "read", { path: "b.ts" }),
      ],
      [toolResult("r1", "x"), toolResult("e1", "ok"), toolResult("r2", "y")],
    );
    expect(split.map((i) => i.kind)).toEqual([
      "spacer",
      "tool-call",
      "spacer",
      "tool-call",
      "spacer",
      "tool-call",
    ]);
  });
});

describe("renderItemToString tool batch", () => {
  const batch = (
    members: Array<{ name: string; id: string }>,
    collapsed: boolean,
  ): string =>
    renderItemToString(
      {
        kind: "tool-batch",
        key: members[0]?.id ?? "k",
        collapsed,
        members: members.map((m) => ({
          use: { type: "tool_use", id: m.id, name: m.name, input: {} },
          result: { type: "tool_result", tool_use_id: m.id, content: "ok" },
        })),
      } as RenderItem,
      80,
    );

  it("renders a single summary line when collapsed", () => {
    const out = batch(
      [
        { name: "grep", id: "g1" },
        { name: "glob", id: "g2" },
        { name: "read", id: "r1" },
        { name: "read", id: "r2" },
        { name: "read", id: "r3" },
        { name: "bash", id: "b1" },
      ],
      true,
    );
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("Search 2 patterns");
    expect(out).toContain("read 3 files");
    expect(out).toContain("run 1 shell command");
  });

  it("stays a single summary line while a member is still pending", () => {
    const out = renderItemToString(
      {
        kind: "tool-batch",
        key: "r1",
        collapsed: true,
        members: [
          {
            use: { type: "tool_use", id: "r1", name: "read", input: {} },
            result: { type: "tool_result", tool_use_id: "r1", content: "ok" },
          },
          // r2 still running — no result. Batch must still render as one line.
          { use: { type: "tool_use", id: "r2", name: "read", input: {} }, result: undefined },
        ],
      } as RenderItem,
      80,
    );
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("Read 2 files");
  });

  it("expands to the full per-call rendering when not collapsed", () => {
    const out = batch(
      [
        { name: "read", id: "r1" },
        { name: "read", id: "r2" },
      ],
      false,
    );
    // Title line plus each member's own multi-line tool-call rendering.
    expect(out.split("\n").length).toBeGreaterThan(2);
    expect(out).toContain("read");
  });

  it("wraps expanded children in a left spine closed with a corner", () => {
    const out = batch(
      [
        { name: "read", id: "r1" },
        { name: "read", id: "r2" },
      ],
      false,
    );
    const rows = out.split("\n");
    // First row is the disclosure title; every child row hangs off the │ spine.
    expect(rows[0]).toContain("▾");
    const body = rows.slice(1);
    expect(body.every((r) => r.includes("│") || r.includes("╰"))).toBe(true);
    // The group is closed by a final corner row.
    expect(rows[rows.length - 1]).toContain("╰");
  });
});

describe("renderItemToString thinking collapse", () => {
  const WIDTH = 80;
  const thinking = (text: string, collapsed: boolean): string =>
    renderItemToString(
      { kind: "thinking", key: "k", thinking: text, collapsed } as RenderItem,
      WIDTH,
    );

  // 6 short lines stay well under the wrap width, so each is its own body row.
  const sixLines = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");

  it("collapses a done thinking block to 3 body rows plus a hint", () => {
    const out = thinking(sixLines, true);
    expect(out).toContain("line 1");
    expect(out).toContain("line 3");
    expect(out).not.toContain("line 4");
    // header + 3 body rows + hint = 5 rows; 6 - 3 = 3 hidden.
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("+3 lines");
  });

  it("does not collapse while still streaming (collapsed false)", () => {
    const out = thinking(sixLines, false);
    expect(out).toContain("line 6");
    expect(out).not.toContain("lines");
    expect(out.split("\n")).toHaveLength(7); // header + 6 body rows
  });

  it("shows no hint when the body already fits in 3 rows", () => {
    const out = thinking("line 1\nline 2", true);
    expect(out).not.toContain("lines");
    expect(out.split("\n")).toHaveLength(3); // header + 2 body rows
  });
});

describe("renderItemToString thinking expand", () => {
  const WIDTH = 80;
  const thinking = (text: string, expanded: boolean): string =>
    renderItemToString(
      { kind: "thinking", key: "k", thinking: text, collapsed: true, expanded } as RenderItem,
      WIDTH,
    );
  const sixLines = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n");

  it("shows the full body and a 'show less' control when expanded", () => {
    const out = thinking(sixLines, true);
    expect(out).toContain("line 1");
    expect(out).toContain("line 6");
    expect(out).toContain("show less");
    expect(out).not.toContain("+");
    // header + 6 body rows + show-less hint = 8 rows.
    expect(out.split("\n")).toHaveLength(8);
  });

  it("falls back to the collapsed preview when expanded is false", () => {
    const out = thinking(sixLines, false);
    expect(out).not.toContain("line 4");
    expect(out).toContain("+3 lines");
  });
});

describe("renderItemToString tool-call body collapse/expand", () => {
  const WIDTH = 80;
  // A 10-line new_string makes the edit diff exceed COMPACT_MAX_LINES (7).
  const newStr = Array.from({ length: 10 }, (_, i) => `new line ${i + 1}`).join("\n");
  const editItem = (result: unknown, expanded?: boolean): RenderItem =>
    ({
      kind: "tool-call",
      key: "tc#1",
      use: {
        type: "tool_use",
        id: "e1",
        name: "edit",
        input: { path: "a.ts", old_string: "", new_string: newStr },
      },
      result,
      ...(expanded !== undefined ? { expanded } : {}),
    }) as RenderItem;

  it("collapses a done edit body to a preview with a collapse hint", () => {
    const out = renderItemToString(
      editItem({ type: "tool_result", tool_use_id: "e1", content: "ok" }),
      WIDTH,
    );
    expect(out).toContain("new line 1");
    expect(out).not.toContain("new line 10");
    expect(out).toContain("hidden");
  });

  it("shows the full body and a 'show less' hint when expanded", () => {
    const out = renderItemToString(
      editItem({ type: "tool_result", tool_use_id: "e1", content: "ok" }, true),
      WIDTH,
    );
    expect(out).toContain("new line 10");
    expect(out).toContain("show less");
    expect(out).not.toContain("hidden");
  });

  it("shows the full body while still pending (no result, no hint)", () => {
    const out = renderItemToString(editItem(undefined), WIDTH);
    expect(out).toContain("new line 10");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("show less");
  });
});

describe("renderItemToString bash command layout", () => {
  const WIDTH = 80;
  const bashItem = (command: string): RenderItem =>
    ({
      kind: "tool-call",
      key: "tc#b",
      use: { type: "tool_use", id: "b1", name: "bash", input: { command } },
      result: undefined,
    }) as RenderItem;

  const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

  const headerLine = (out: string): string => stripAnsi(out).split("\n")[0] ?? "";

  it("renders a single-row command inline in the header", () => {
    // The header row carries the whole command; below it sits only the standard
    // body-less result elbow (`⎿ …`), exactly like read/grep — no command body.
    const out = renderItemToString(bashItem('sleep 20 & echo "complete"'), WIDTH);
    expect(headerLine(out)).toContain('bash  sleep 20 & echo "complete"');
    expect(stripAnsi(out).split("\n")).toHaveLength(2); // header + ⎿ result
  });

  it("keeps a multi-line command in the ⎿ body, not the header", () => {
    const out = stripAnsi(renderItemToString(bashItem("echo a\necho b"), WIDTH));
    expect(headerLine(out)).not.toContain("echo a");
    expect(out).toContain("⎿");
    expect(out).toContain("echo a");
    expect(out).toContain("echo b");
  });

  it("moves a single logical line that would wrap into the ⎿ body", () => {
    const long = `echo ${"x".repeat(WIDTH)}`;
    const out = renderItemToString(bashItem(long), WIDTH);
    // Header no longer carries the command inline; it wraps under the gutter.
    expect(headerLine(out)).not.toContain("xxxx");
    expect(stripAnsi(out)).toContain("⎿");
  });
});

describe("buildRenderItems tool-call expand state", () => {
  const longContent = Array.from({ length: 12 }, (_, i) => `c${i}`).join("\n");
  const build = (expandedItems?: Record<string, boolean>) =>
    buildRenderItems({
      banner: null,
      cards: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "w1", name: "write", input: { path: "x.ts", content: longContent } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] },
      ],
      ...(expandedItems ? { expandedItems } : {}),
    }).find((i) => i.kind === "tool-call");

  it("marks a write call expanded when its key is in expandedItems", () => {
    const collapsed = build();
    expect(collapsed).not.toHaveProperty("expanded");
    const key = collapsed && collapsed.kind === "tool-call" ? collapsed.key : "";
    expect(key).toBeTruthy();
    const expanded = build({ [key]: true });
    expect(expanded).toMatchObject({ expanded: true });
  });
});

describe("buildRenderItems thinking expand state", () => {
  const longThinking = Array.from({ length: 8 }, (_, i) => `r${i}`).join("\n");
  const buildThinking = (expandedItems?: Record<string, boolean>) => {
    const items = buildRenderItems({
      banner: null,
      cards: [],
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: longThinking, signature: "s" }] },
      ],
      ...(expandedItems ? { expandedItems } : {}),
    });
    return items.find((i) => i.kind === "thinking");
  };

  it("marks a committed thinking item expanded when its key is in expandedItems", () => {
    const collapsed = buildThinking();
    expect(collapsed && collapsed.kind === "thinking" ? collapsed.key : "").toBeTruthy();
    const key = collapsed && collapsed.kind === "thinking" ? collapsed.key : "";
    // Default: not expanded.
    expect(collapsed).not.toHaveProperty("expanded");
    // With the key flagged, the same block builds as expanded.
    const expanded = buildThinking({ [key]: true });
    expect(expanded).toMatchObject({ collapsed: true, expanded: true });
  });
});
