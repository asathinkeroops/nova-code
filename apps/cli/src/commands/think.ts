import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "@nova/core";
import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import { thinkingLevelLabel, type CliContext } from "../context.js";

async function persistThinking(ctx: CliContext): Promise<void> {
  ctx.settings.thinking.level = ctx.thinkingLevel;
  ctx.settings.thinking.budgetTokens = ctx.thinkingBudgetOverride;
  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  try {
    await saveSettings({ thinking: ctx.settings.thinking });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.print(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
}

export async function handleThink(ctx: CliContext, arg: string): Promise<void> {
  ctx.screen.print("\n");
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
      ctx.screen.print(`${dim("cancelled.")}\n`);
      return;
    }
    ctx.thinkingLevel = pick;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    ctx.screen.print(`${dim("thinking set to")} ${pick}\n`);
    return;
  }

  const asNumber = Number.parseInt(arg, 10);
  if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
    ctx.thinkingBudgetOverride = asNumber;
    await persistThinking(ctx);
    ctx.screen.print(
      `${dim("thinking budget set to")} ${asNumber} ${dim(`tokens (level: ${ctx.thinkingLevel})`)}\n`,
    );
    return;
  }
  if (isThinkingLevel(arg)) {
    ctx.thinkingLevel = arg;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    ctx.screen.print(`${dim("thinking set to")} ${arg}\n`);
    return;
  }
  ctx.screen.print(
    `${red("✗")} ${dim("expected off|low|medium|high|max or a positive integer")}\n`,
  );
}
