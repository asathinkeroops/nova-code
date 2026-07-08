import { buildSystemPrompt } from "@nova/agent";
import { estimateTokens, sliceFromLastCompacted } from "@nova/context";
import { toWireTools } from "@nova/core";
import type { SlashOutcome } from "@nova/external";
import { resolveContextWindowSize } from "@nova/runtime";
import { bold, dim, green, PURPLE_HEX } from "../colors.js";
import type { CliContext } from "../context.js";
import { buildFixPrompt, diagnoseConfig, formatIssues, summarizeReport } from "../doctor.js";
import { formatPercent, formatTokenCount } from "../ui/status-format.js";

const MCP_PREFIX = "mcp__";

/** DeepSeek's documented ~0.3 tokens/char, matching `@nova/context`'s estimator. */
function estimateChars(s: string): number {
  return Math.ceil(s.length * 0.3);
}

/**
 * A live snapshot of what the NEXT request's prompt would occupy, against the
 * active tier's window — the same categories/estimate `/context` uses, collapsed
 * to a couple of summary lines for the doctor modal.
 */
function contextUsageLines(ctx: CliContext): string[] {
  const window = resolveContextWindowSize(ctx.settings, ctx.settings.model);
  const systemTokens = estimateChars(
    buildSystemPrompt(
      ctx.workspace,
      ctx.memory,
      ctx.session.id,
      ctx.skillsBlock,
      ctx.settings.language,
    ),
  );
  const wire = toWireTools(ctx.tools.definitions());
  const toolsTokens = wire.length ? estimateChars(JSON.stringify(wire)) : 0;
  const mcpCount = wire.filter((t) => t.name.startsWith(MCP_PREFIX)).length;
  const messagesTokens = estimateTokens(sliceFromLastCompacted(ctx.screen.getMessages()));
  const used = systemTokens + toolsTokens + messagesTokens;
  const pct = window > 0 ? used / window : 0;
  return [
    `context: ${formatTokenCount(used)} / ${formatTokenCount(window)} (${formatPercent(pct)}) — ` +
      `system ${formatTokenCount(systemTokens)}, tools ${formatTokenCount(toolsTokens)}` +
      `${mcpCount > 0 ? ` (${mcpCount} mcp)` : ""}, messages ${formatTokenCount(messagesTokens)}`,
  ];
}

/** Compose the modal body: config health, then info + live context usage. */
function modalBody(
  report: Awaited<ReturnType<typeof diagnoseConfig>>["report"],
  ctx: CliContext,
): string {
  const lines = [bold("nova config check"), dim(report.configPath), ""];
  if (!report.exists) {
    lines.push(dim("no config file yet — first-time setup runs on launch."));
  } else if (report.issues.length === 0) {
    lines.push(green("✓ config looks good"));
  } else {
    lines.push(formatIssues(report), "", dim(summarizeReport(report)));
  }
  const extra = [...report.info, ...contextUsageLines(ctx)];
  if (extra.length > 0) {
    lines.push("");
    for (const e of extra) lines.push(dim(`· ${e}`));
  }
  return lines.join("\n");
}

type Action = "fix" | "close";

/**
 * Re-run the config check on demand and show it in an overlay. Reads the global
 * config fresh from disk (not `ctx.settings`) so edits since launch are
 * reflected, and validates the workspace's project hook files too. When there
 * are issues, pressing `f` (or choosing "Fix") hands them to the agent as a
 * prompt to repair the config in place.
 */
export async function handleDoctor(ctx: CliContext): Promise<SlashOutcome> {
  const { report } = await diagnoseConfig({ workspace: ctx.workspace });
  const canFix = report.issues.length > 0;

  const items: Action[] = canFix ? ["fix", "close"] : ["close"];
  const choice = await ctx.screen.pickHorizontal<Action>({
    items,
    label: (a) => (a === "fix" ? "Fix issues" : "Close"),
    header: modalBody(report, ctx),
    footer: canFix
      ? "f fix · ←/→ choose · Enter confirm · Esc close"
      : "Enter / Esc to close",
    border: false,
    topRuleColor: PURPLE_HEX,
    ...(canFix ? { hotkeys: { f: "fix" as Action } } : {}),
  });

  if (choice === "fix") return { kind: "prompt", text: buildFixPrompt(report) };
  return { kind: "handled" };
}
