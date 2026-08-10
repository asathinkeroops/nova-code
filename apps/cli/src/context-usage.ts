import { buildSystemPrompt } from "@nova/agent";
import { estimateTextTokens, resolveProfile, toWireTools, type TokenEstimate } from "@nova/core";
import type { CliContext } from "./ctx-types.js";

/** MCP tools are namespaced; split out because they often dominate the schema budget. */
export const MCP_PREFIX = "mcp__";

/**
 * The part of every request that is NOT conversation: the system prompt (core
 * instructions + memory bundle + skills block) and the tool schemas. It is
 * re-sent verbatim on every call, so it occupies the context window just as
 * surely as the messages do.
 */
export interface FixedOverhead {
  /** Base prompt + language guard + glue, with memory/skills attributed separately. */
  systemTokens: number;
  memoryTokens: number;
  skillsTokens: number;
  /** Built-in tool schemas, sized as the exact wire payload. */
  toolsTokens: number;
  mcpTokens: number;
}

export function fixedOverheadTotal(o: FixedOverhead): number {
  return o.systemTokens + o.memoryTokens + o.skillsTokens + o.toolsTokens + o.mcpTokens;
}

/**
 * Measure the non-conversation part of the next request.
 *
 * Single source of truth for two consumers that MUST agree: the `/context`
 * panel, which shows the user how the window is spent, and the auto-compaction
 * trigger, which decides when it is too full. They used to disagree — the panel
 * counted this overhead against the threshold while the trigger ignored it, so
 * the trigger fired later than the panel implied. Harmless at a 50% threshold
 * with half a window of slack; at 90% it is the difference between fitting and
 * overflowing on a small context window.
 *
 * Read live rather than cached: tools change as MCP servers connect and as plan
 * mode swaps the registry, and the memory bundle is rebuilt at session
 * boundaries.
 */
export function measureFixedOverhead(ctx: CliContext, weights?: TokenEstimate): FixedOverhead {
  const w = weights ?? resolveProfile(ctx.settings.provider).tokenEstimate;
  const est = (s: string): number => estimateTextTokens(s, w);

  const fullSystem = buildSystemPrompt(
    ctx.workspace,
    ctx.memory,
    ctx.session.id,
    ctx.skillsBlock,
    ctx.settings.language,
  );
  const memoryTokens = est(ctx.memory.system);
  const skillsTokens = est(ctx.skillsBlock);
  const systemTokens = Math.max(0, est(fullSystem) - memoryTokens - skillsTokens);

  const wire = toWireTools(ctx.tools.definitions());
  const builtinWire = wire.filter((t) => !t.name.startsWith(MCP_PREFIX));
  const mcpWire = wire.filter((t) => t.name.startsWith(MCP_PREFIX));

  return {
    systemTokens,
    memoryTokens,
    skillsTokens,
    toolsTokens: builtinWire.length ? est(JSON.stringify(builtinWire)) : 0,
    mcpTokens: mcpWire.length ? est(JSON.stringify(mcpWire)) : 0,
  };
}
