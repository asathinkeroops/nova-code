import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "@nova/core";
import { saveSettings } from "@nova/runtime";
import { dim } from "../colors.js";
import { thinkingLevelLabel, type CliContext } from "../context.js";

const TITLE = "/think";

async function persistThinking(ctx: CliContext): Promise<void> {
  ctx.settings.thinking.level = ctx.thinkingLevel;
  ctx.settings.thinking.budgetTokens = ctx.thinkingBudgetOverride;
  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  try {
    await saveSettings({ thinking: ctx.settings.thinking });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to save settings: ${msg}`, { kind: "error", title: TITLE });
  }
}

export async function handleThink(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    const currentIdx = THINKING_LEVELS.indexOf(ctx.thinkingLevel);
    const pick = await ctx.screen.pickHorizontal<ThinkingLevel>({
      items: [...THINKING_LEVELS],
      header: dim("select thinking level:"),
      footer: dim("← → navigate · enter confirm · esc cancel"),
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      label: (level) => level,
    });
    if (!pick) {
      ctx.screen.card(dim("cancelled."), { title: TITLE });
      return;
    }
    ctx.thinkingLevel = pick;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    ctx.screen.card(`${dim("thinking set to")} ${pick}`, { title: TITLE });
    return;
  }

  const asNumber = Number.parseInt(arg, 10);
  if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
    ctx.thinkingBudgetOverride = asNumber;
    await persistThinking(ctx);
    ctx.screen.card(
      `${dim("thinking budget set to")} ${asNumber} ${dim(`tokens (level: ${ctx.thinkingLevel})`)}`,
      { title: TITLE },
    );
    return;
  }
  if (isThinkingLevel(arg)) {
    ctx.thinkingLevel = arg;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    ctx.screen.card(`${dim("thinking set to")} ${arg}`, { title: TITLE });
    return;
  }
  ctx.screen.card(
    "expected off|low|medium|high|max or a positive integer",
    { kind: "error", title: TITLE },
  );
}
