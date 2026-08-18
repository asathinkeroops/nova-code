import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition, ToolPromptSection } from "@nova/core";
import { presentList, renderToolPrompts, staticSection } from "./prompt.js";
import { BUILTIN_TOOL_PROMPTS } from "./index.js";

function tool(name: string): ToolDefinition {
  return { name, description: `does ${name}`, inputSchema: z.object({}) };
}

const alpha = staticSection({ id: "alpha", requires: ["a"], text: "- alpha" });
const beta = staticSection({ id: "beta", requires: ["b"], text: "- beta" });

describe("renderToolPrompts", () => {
  it("emits a section only when every required tool is present", () => {
    const out = renderToolPrompts([tool("a")], [alpha, beta]);
    expect(out.sections.map((s) => s.id)).toEqual(["alpha"]);
    expect(out.text).toContain("- alpha");
    expect(out.text).not.toContain("- beta");
  });

  it("emits a requiresAny section when at least one is present", () => {
    const either = staticSection({ id: "either", requiresAny: ["x", "y"], text: "- either" });
    expect(renderToolPrompts([tool("y")], [either]).text).toContain("- either");
    expect(renderToolPrompts([tool("z")], [either]).text).toBe("");
  });

  it("returns an empty string — not an empty wrapper — when nothing qualifies", () => {
    // The caller drops the whole region on "", so an empty <tool-guidance> would
    // put a meaningless tag into every request's cached prefix.
    const out = renderToolPrompts([], [alpha, beta]);
    expect(out.text).toBe("");
    expect(out.sections).toEqual([]);
  });

  it("orders by `order`, keeping input order within a tier", () => {
    const late = staticSection({ id: "late", order: 200, text: "- late" });
    const early = staticSection({ id: "early", order: 1, text: "- early" });
    const tiedA = staticSection({ id: "tied-a", order: 50, text: "- tied-a" });
    const tiedB = staticSection({ id: "tied-b", order: 50, text: "- tied-b" });
    const out = renderToolPrompts([], [late, tiedA, tiedB, early]);
    expect(out.sections.map((s) => s.id)).toEqual(["early", "tied-a", "tied-b", "late"]);
  });

  it("keeps the first section for a duplicated id", () => {
    const first = staticSection({ id: "dup", text: "- first" });
    const second = staticSection({ id: "dup", text: "- second" });
    const out = renderToolPrompts([], [first, second]);
    expect(out.sections).toEqual([{ id: "dup", text: "- first" }]);
  });

  it("renders the same bytes for the same tool set regardless of tool order", () => {
    // The block lands in the system prompt, which is byte 0 of the request
    // prefix and frozen for the epoch — a set-dependent-but-order-dependent
    // render would silently change the prefix between sessions.
    // Section order is authored, so only the TOOL order varies here — that is
    // the half that shifts at runtime (registration timing, MCP, denylist).
    const forward = renderToolPrompts([tool("a"), tool("b")], [alpha, beta]);
    const reverse = renderToolPrompts([tool("b"), tool("a")], [alpha, beta]);
    expect(forward.text).toBe(reverse.text);
  });

  it("drops a section whose render returns nothing", () => {
    const blank: ToolPromptSection = { id: "blank", render: () => "   " };
    expect(renderToolPrompts([], [blank]).text).toBe("");
  });
});

describe("presentList", () => {
  it("names only the tools that survived, in declaration order", () => {
    const ctx = { present: new Set(["createTodo", "getTodoList"]) };
    expect(presentList(ctx, ["createTodo", "updateTodo", "getTodoList"])).toBe(
      "createTodo / getTodoList",
    );
  });
});

describe("BUILTIN_TOOL_PROMPTS", () => {
  it("says nothing when the session has no tools at all", () => {
    expect(renderToolPrompts([], BUILTIN_TOOL_PROMPTS).text).toBe("");
  });

  it("teaches the todo checklist only once the todo tools exist", () => {
    const withoutTodo = renderToolPrompts([tool("read")], BUILTIN_TOOL_PROMPTS).text;
    expect(withoutTodo).not.toContain("createTodo");

    const withTodo = renderToolPrompts(
      ["createTodo", "updateTodo", "getTodoList", "clearTodoList"].map(tool),
      BUILTIN_TOOL_PROMPTS,
    ).text;
    expect(withTodo).toContain("createTodo / updateTodo / getTodoList / clearTodoList");
  });

  it("stops naming a todo tool that permissions.deny removed", () => {
    const denied = renderToolPrompts(
      ["createTodo", "updateTodo", "getTodoList"].map(tool),
      BUILTIN_TOOL_PROMPTS,
    ).text;
    expect(denied).toContain("createTodo / updateTodo / getTodoList");
    expect(denied).not.toContain("clearTodoList");
  });

  it("withholds the run_in_background guidance when no background manager is wired", () => {
    // bash exists in every session; its run_in_background branch does not — it
    // needs the manager that also brings killBackground.
    expect(renderToolPrompts([tool("bash")], BUILTIN_TOOL_PROMPTS).text).not.toContain(
      "run_in_background",
    );
    expect(
      renderToolPrompts([tool("bash"), tool("killBackground")], BUILTIN_TOOL_PROMPTS).text,
    ).toContain("run_in_background");
  });

  it("withholds plan-mode guidance unless BOTH plan-mode tools are registered", () => {
    // Telling the model to enter a mode it has no way to leave is worse than
    // saying nothing.
    expect(renderToolPrompts([tool("enterPlanMode")], BUILTIN_TOOL_PROMPTS).text).not.toContain(
      "enterPlanMode",
    );
    expect(
      renderToolPrompts([tool("enterPlanMode"), tool("exitPlanMode")], BUILTIN_TOOL_PROMPTS).text,
    ).toContain("exitPlanMode");
  });
});
