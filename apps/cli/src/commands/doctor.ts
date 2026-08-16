import { buildSystemPrompt, estimateTokens, sliceFromLastCompacted } from "@nova/agent";
import {
  toWireTools,
} from "@nova/core";
import {
  resolveProfile,
} from "@nova/model";
import {
  estimateTextTokens,
} from "@nova/runtime";
import { resolveContextWindowSize, type SlashOutcome } from "@nova/runtime";
import { ACCENT_HEX, bold, dim, green } from "../colors.js";
import type { CliContext } from "../context.js";
import { buildFixPrompt, diagnoseConfig, formatIssues, summarizeReport } from "../doctor.js";
import { t } from "../i18n/index.js";
import { formatPercent, formatTokenCount } from "../ui/status-format.js";

const MCP_PREFIX = "mcp__";

/**
 * A live snapshot of what the NEXT request's prompt would occupy, against the
 * active tier's window — the same categories/estimate `/context` uses, collapsed
 * to a couple of summary lines for the doctor modal.
 */
function contextUsageLines(ctx: CliContext): string[] {
  const window = resolveContextWindowSize(ctx.settings, ctx.settings.model);
  // Weight the estimate by the active provider's tokenizer ratios, matching
  // `/context` and what `shouldAutoCompact` triggers on.
  const weights = resolveProfile(ctx.settings.provider).tokenEstimate;
  const estimateChars = (s: string): number => estimateTextTokens(s, weights);
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
  const messagesTokens = estimateTokens(sliceFromLastCompacted(ctx.screen.getMessages()), weights);
  const used = systemTokens + toolsTokens + messagesTokens;
  const pct = window > 0 ? used / window : 0;
  return [
    t.doctor.contextUsage({
      used: formatTokenCount(used),
      window: formatTokenCount(window),
      pct: formatPercent(pct),
      system: formatTokenCount(systemTokens),
      tools: formatTokenCount(toolsTokens),
      mcp: mcpCount,
      messages: formatTokenCount(messagesTokens),
    }),
  ];
}

/** Compose the modal body: config health, then info + live context usage. */
function modalBody(
  report: Awaited<ReturnType<typeof diagnoseConfig>>["report"],
  ctx: CliContext,
): string {
  const lines = [bold(t.doctor.configCheckTitle), dim(report.configPath), ""];
  if (!report.exists) {
    lines.push(dim(t.doctor.noConfigFileModal));
  } else if (report.issues.length === 0) {
    lines.push(green(t.doctor.looksGood));
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
    label: (a) => (a === "fix" ? t.doctor.labelFix : t.doctor.labelClose),
    header: modalBody(report, ctx),
    footer: canFix ? t.doctor.footerFix : t.doctor.footerClose,
    border: false,
    topRuleColor: ACCENT_HEX,
    ...(canFix ? { hotkeys: { f: "fix" as Action } } : {}),
  });

  if (choice === "fix") return { kind: "prompt", text: buildFixPrompt(report) };
  return { kind: "handled" };
}
