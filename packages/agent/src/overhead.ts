/**
 * The non-conversation part of a request, measured in tokens.
 *
 * Lives next to `compact.ts` on purpose: the auto-compaction trigger counts this
 * against its threshold (`CompactTriggerOptions.overheadTokens`) and a host's
 * context panel shows it to the user. Those two MUST agree, so they share one
 * measurement rather than each deriving its own.
 */

import { toWireTools, type ToolDefinition } from "@nova/core";
import { DEFAULT_TOKEN_ESTIMATE, estimateTextTokens, type TokenEstimate } from "@nova/base";
import type { MemoryBundle } from "./memory.js";
import { buildSystemPrompt } from "./system-prompt.js";

/**
 * The part of every request that is NOT conversation: the system prompt (core
 * instructions + memory bundle + tool guidance) and the tool schemas. It is
 * re-sent verbatim on every call, so it occupies the context window just as
 * surely as the messages do.
 */
export interface FixedOverhead {
  /**
   * Base prompt + tool guidance + language guard + glue, with memory and the
   * skills index attributed separately.
   */
  systemTokens: number;
  memoryTokens: number;
  skillsTokens: number;
  /** Built-in tool schemas, sized as the exact wire payload. */
  toolsTokens: number;
  /** Schemas of tools the caller classified as bridged (MCP). 0 when none are. */
  mcpTokens: number;
}

export function fixedOverheadTotal(o: FixedOverhead): number {
  return o.systemTokens + o.memoryTokens + o.skillsTokens + o.toolsTokens + o.mcpTokens;
}

/**
 * Everything the measurement needs, as plain values — the same inputs
 * `createMemoryPrompt` feeds `buildSystemPrompt`, plus the live tool list.
 */
export interface FixedOverheadInput {
  workspace: string;
  memory: MemoryBundle;
  sessionId: string;
  /** The rendered tool-guidance block, exactly as `buildSystemPrompt` receives it. */
  toolsGuidance: string;
  /**
   * The skills-index section's own text, a slice of {@link toolsGuidance}. Passed
   * separately only so the host can report it as its own row — it dominates the
   * block whenever a user has many skills. Omit to fold it into `systemTokens`.
   */
  skillsBlock?: string;
  /** Resolved response language; defaults to `buildSystemPrompt`'s own default. */
  language?: string;
  /** The tool definitions the next request will carry. */
  tools: ToolDefinition[];
  /** Provider tokenizer ratios (CJK vs. rest). Defaults to {@link DEFAULT_TOKEN_ESTIMATE}. */
  tokenEstimate?: TokenEstimate;
  /**
   * Classifies a tool name as bridged from MCP, so its schema is reported in
   * `mcpTokens` instead of `toolsTokens` — bridged servers often dominate the
   * schema budget and users need to see that separately. The predicate is
   * injected because the namespace belongs to `@nova/mcp`, which this package
   * does not depend on. Omit to count every tool as built-in.
   */
  isMcpTool?: (name: string) => boolean;
}

/**
 * Measure the non-conversation part of the next request.
 *
 * Single source of truth for two consumers that MUST agree: the host's context
 * panel, which shows the user how the window is spent, and the auto-compaction
 * trigger, which decides when it is too full. They used to disagree — the panel
 * counted this overhead against the threshold while the trigger ignored it, so
 * the trigger fired later than the panel implied. Harmless at a 50% threshold
 * with half a window of slack; at 90% it is the difference between fitting and
 * overflowing on a small context window.
 *
 * Call it live rather than caching: tools change as MCP servers connect and as
 * plan mode swaps the registry, and the memory bundle is rebuilt at session
 * boundaries.
 */
export function measureFixedOverhead(input: FixedOverheadInput): FixedOverhead {
  const weights = input.tokenEstimate ?? DEFAULT_TOKEN_ESTIMATE;
  const est = (s: string): number => estimateTextTokens(s, weights);

  const fullSystem = buildSystemPrompt({
    workspace: input.workspace,
    memory: input.memory,
    sessionId: input.sessionId,
    toolsGuidance: input.toolsGuidance,
    ...(input.language !== undefined ? { language: input.language } : {}),
  });
  const memoryTokens = est(input.memory.system);
  const skillsTokens = input.skillsBlock ? est(input.skillsBlock) : 0;
  // Memory and skills are embedded in the prompt, so subtract them out rather
  // than double-counting; clamped because the estimate is not exactly additive.
  const systemTokens = Math.max(0, est(fullSystem) - memoryTokens - skillsTokens);

  const isMcp = input.isMcpTool ?? ((): boolean => false);
  const wire = toWireTools(input.tools);
  const builtinWire = wire.filter((t) => !isMcp(t.name));
  const mcpWire = wire.filter((t) => isMcp(t.name));

  return {
    systemTokens,
    memoryTokens,
    skillsTokens,
    toolsTokens: builtinWire.length ? est(JSON.stringify(builtinWire)) : 0,
    mcpTokens: mcpWire.length ? est(JSON.stringify(mcpWire)) : 0,
  };
}
