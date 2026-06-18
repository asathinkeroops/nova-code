import { buildSystemPrompt } from "@nova/agent";
import { computeThreshold, estimateTokens } from "@nova/context";
import { toWireTools } from "@nova/core";
import { resolveContextWindowTokens } from "@nova/runtime";
import { accent, blue, bold, cyan, dim, green, magenta, yellow } from "../colors.js";
import type { CliContext } from "../context.js";
import { contextBar, formatPercent, formatTokenCount } from "../ui/status-format.js";

const TITLE = "/context";
const MCP_PREFIX = "mcp__";

/** Rough token estimate for a serialized string (~4 chars / token), matching
 *  `@nova/context`'s `estimateTokens` methodology so the breakdown lines up
 *  with the auto-compact threshold. */
function estimateChars(s: string): number {
  return Math.ceil(s.length / 4);
}

interface Row {
  label: string;
  tokens: number;
  /** Colorizer for the row's leading block + token figure. */
  color: (s: string) => string;
  /** Drop the row when its token count is 0 (optional/empty categories). */
  hideWhenEmpty?: boolean;
}

/**
 * Visualize what currently occupies the model's context window, broken out by
 * category — system prompt, memory, skills, tool schemas, MCP tools, and the
 * conversation — against the active model tier's window. Unlike `/usage` (which
 * reports cumulative per-session token spend), this is a live snapshot of the
 * NEXT request's prompt: every figure is re-derived from the current message
 * buffer, tool registry, and memory bundle using the same ~4-chars/token
 * estimate the auto-compactor uses. When auto-compact is enabled, the window is
 * split into usable space (up to the compaction threshold) and a reserved
 * "autocompact buffer" above it.
 */
export function handleContext(ctx: CliContext): void {
  const windowTokens = resolveContextWindowTokens(ctx.settings, ctx.settings.model);

  // System prompt = core instructions + memory bundle + skills block. We size
  // the whole thing, then attribute memory/skills to their own rows and treat
  // the remainder (base prompt + language guard + glue) as "system prompt".
  const fullSystem = buildSystemPrompt(
    ctx.workspace,
    ctx.memory,
    ctx.session.id,
    ctx.skillsBlock,
  );
  const memoryTokens = estimateChars(ctx.memory.system);
  const skillsTokens = estimateChars(ctx.skillsBlock);
  const systemTokens = Math.max(0, estimateChars(fullSystem) - memoryTokens - skillsTokens);

  // Tool schemas, sized as the exact wire payload the model receives. MCP tools
  // (prefixed `mcp__`) are split out since they're often the bulk of the budget.
  const wire = toWireTools(ctx.tools.definitions());
  const builtinWire = wire.filter((t) => !t.name.startsWith(MCP_PREFIX));
  const mcpWire = wire.filter((t) => t.name.startsWith(MCP_PREFIX));
  const toolsTokens = builtinWire.length ? estimateChars(JSON.stringify(builtinWire)) : 0;
  const mcpTokens = mcpWire.length ? estimateChars(JSON.stringify(mcpWire)) : 0;

  const messagesTokens = estimateTokens(ctx.screen.getMessages());

  const used =
    systemTokens + memoryTokens + skillsTokens + toolsTokens + mcpTokens + messagesTokens;

  // Auto-compact reserves the slice of the window above its trigger threshold;
  // free space is what remains below it. With auto-compact off, the whole
  // window is usable and there is no reserved buffer.
  const auto = ctx.settings.compact.auto;
  const threshold = auto.enabled
    ? computeThreshold({
        contextWindowTokens: windowTokens,
        thresholdTokens: auto.thresholdTokens,
        contextWindowPercent: auto.contextWindowPercent,
      })
    : windowTokens;
  const autocompactBuffer = Math.max(0, windowTokens - threshold);
  const freeSpace = Math.max(0, threshold - used);

  const rows: Row[] = [
    { label: "system prompt", tokens: systemTokens, color: blue },
    { label: "memory files", tokens: memoryTokens, color: green, hideWhenEmpty: true },
    { label: "skills", tokens: skillsTokens, color: yellow, hideWhenEmpty: true },
    { label: "tools", tokens: toolsTokens, color: cyan },
    { label: "mcp tools", tokens: mcpTokens, color: magenta, hideWhenEmpty: true },
    { label: "messages", tokens: messagesTokens, color: accent },
    { label: "free space", tokens: freeSpace, color: dim },
    { label: "autocompact buffer", tokens: autocompactBuffer, color: dim, hideWhenEmpty: true },
  ];

  const pad = (s: string): string => dim(s.padEnd(20, " "));
  const pct = (n: number): string =>
    windowTokens > 0 ? dim(formatPercent(n / windowTokens).padStart(4, " ")) : "";

  const usedPercent = windowTokens > 0 ? (used / windowTokens) * 100 : 0;
  const lines: string[] = [
    `${accent(contextBar(usedPercent, 28))}  ${bold(cyan(formatPercent(used / Math.max(1, windowTokens))))}  ${dim(
      `(${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} · ${ctx.settings.model})`,
    )}`,
    "",
  ];

  for (const r of rows) {
    if (r.hideWhenEmpty && r.tokens === 0) continue;
    lines.push(
      `${r.color("█")} ${pad(r.label)}${formatTokenCount(r.tokens).padEnd(8, " ")}${pct(r.tokens)}`,
    );
  }

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
