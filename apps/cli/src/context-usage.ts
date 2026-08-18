import { measureFixedOverhead, type FixedOverhead } from "@nova/agent";
import { MCP_TOOL_PREFIX } from "@nova/mcp";
import { resolveProfile } from "@nova/model";
import type { TokenEstimate } from "@nova/base";
import type { CliContext } from "./ctx-types.js";

/** MCP tools are namespaced; split out because they often dominate the schema budget. */
const isMcpTool = (name: string): boolean => name.startsWith(`${MCP_TOOL_PREFIX}__`);

/**
 * Bind the CLI session to `@nova/agent`'s overhead measurement — the live tool
 * registry, memory bundle, tool-guidance block, and the active provider's tokenizer
 * ratios. The measurement itself lives beside the compaction threshold that
 * consumes it; only this mapping is CLI-shaped.
 */
export function measureCtxOverhead(ctx: CliContext, weights?: TokenEstimate): FixedOverhead {
  return measureFixedOverhead({
    workspace: ctx.workspace,
    memory: ctx.memory,
    sessionId: ctx.session.id,
    toolsGuidance: ctx.toolsGuidance,
    // A slice of toolsGuidance, passed separately only so the skills index keeps
    // its own row in `/context`.
    skillsBlock: ctx.skillsBlock,
    ...(ctx.settings.language !== undefined ? { language: ctx.settings.language } : {}),
    tools: ctx.tools.definitions(),
    tokenEstimate: weights ?? resolveProfile(ctx.settings.provider).tokenEstimate,
    isMcpTool,
  });
}
