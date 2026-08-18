import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@nova/core";
import { fixedOverheadTotal, measureFixedOverhead } from "./overhead.js";
import type { MemoryBundle } from "./memory.js";

const EMPTY_MEMORY: MemoryBundle = { system: "", sources: [] };

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `does ${name}`,
    inputSchema: z.object({ path: z.string() }),
  };
}

function measure(
  over: Partial<Parameters<typeof measureFixedOverhead>[0]> = {},
): ReturnType<typeof measureFixedOverhead> {
  return measureFixedOverhead({
    workspace: "/w",
    memory: EMPTY_MEMORY,
    sessionId: "s1",
    toolsGuidance: "",
    tools: [],
    ...over,
  });
}

describe("measureFixedOverhead", () => {
  it("counts the system prompt even with no memory, skills, or tools", () => {
    const o = measure();
    expect(o.systemTokens).toBeGreaterThan(0);
    expect(o).toMatchObject({ memoryTokens: 0, skillsTokens: 0, toolsTokens: 0, mcpTokens: 0 });
  });

  it("attributes memory and skills separately instead of double-counting them", () => {
    const memory: MemoryBundle = { system: "m".repeat(4000), sources: [] };
    const skillsBlock = "s".repeat(2000);
    const bare = measure();
    // The skills index is a SLICE of the tool-guidance block — that block is
    // what the prompt embeds, `skillsBlock` only says how much of it to
    // attribute to skills. Pass both, exactly as the host does.
    const full = measure({ memory, toolsGuidance: skillsBlock, skillsBlock });

    expect(full.memoryTokens).toBeGreaterThan(0);
    expect(full.skillsTokens).toBeGreaterThan(0);
    // The bundle and the block are embedded IN the prompt, so systemTokens must
    // stay flat as they grow — otherwise the panel reports them twice and the
    // compaction trigger fires early.
    expect(Math.abs(full.systemTokens - bare.systemTokens)).toBeLessThan(10);
    expect(fixedOverheadTotal(full)).toBeGreaterThan(fixedOverheadTotal(bare));
  });

  it("folds tool guidance that is not the skills index into systemTokens", () => {
    // Guidance bullets are part of the system prompt and have no row of their
    // own, so they must show up in systemTokens rather than vanish.
    const bare = measure();
    const guided = measure({ toolsGuidance: "- some tool guidance\n".repeat(100) });
    expect(guided.skillsTokens).toBe(0);
    expect(guided.systemTokens).toBeGreaterThan(bare.systemTokens);
  });

  it("sizes tool schemas as the wire payload", () => {
    const none = measure();
    const some = measure({ tools: [tool("read"), tool("write")] });
    expect(some.toolsTokens).toBeGreaterThan(0);
    expect(fixedOverheadTotal(some) - fixedOverheadTotal(none)).toBe(some.toolsTokens);
  });

  it("splits bridged tools into mcpTokens via the injected predicate", () => {
    const tools = [tool("read"), tool("mcp__git__status"), tool("mcp__git__log")];
    const split = measure({ tools, isMcpTool: (n) => n.startsWith("mcp__") });
    expect(split.toolsTokens).toBeGreaterThan(0);
    expect(split.mcpTokens).toBeGreaterThan(0);

    // Without a predicate every tool is built-in — the total is unchanged, only
    // the attribution moves.
    const lumped = measure({ tools });
    expect(lumped.mcpTokens).toBe(0);
    expect(lumped.toolsTokens).toBeGreaterThan(split.toolsTokens);
  });

  it("weights the estimate by the provider's tokenizer ratios", () => {
    const memory: MemoryBundle = { system: "中".repeat(1000), sources: [] };
    const cheap = measure({ memory, tokenEstimate: { cjk: 0.5, other: 0.25 } });
    const dear = measure({ memory, tokenEstimate: { cjk: 1, other: 0.25 } });
    expect(dear.memoryTokens).toBeGreaterThan(cheap.memoryTokens);
  });
});
