import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "@nova/core";
import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { pickHorizontal } from "../picker.js";

async function persistThinking(ctx: CliContext): Promise<void> {
  ctx.settings.thinking.level = ctx.thinkingLevel;
  ctx.settings.thinking.budgetTokens = ctx.thinkingBudgetOverride;
  try {
    await saveSettings({ thinking: ctx.settings.thinking });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
}

export async function handleThink(ctx: CliContext, arg: string): Promise<void> {
  process.stdout.write("\n");
  if (!arg) {
    const currentIdx = THINKING_LEVELS.indexOf(ctx.thinkingLevel);
    const pick = await pickHorizontal<ThinkingLevel>({
      items: [...THINKING_LEVELS],
      header: dim("select thinking level:"),
      footer: dim("← → navigate · enter confirm · esc cancel"),
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      label: (level) => level,
    });
    if (!pick) {
      process.stdout.write(`${dim("cancelled.")}\n`);
      return;
    }
    ctx.thinkingLevel = pick;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    process.stdout.write(`${dim("thinking set to")} ${pick}\n`);
    return;
  }

  const asNumber = Number.parseInt(arg, 10);
  if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
    ctx.thinkingBudgetOverride = asNumber;
    await persistThinking(ctx);
    process.stdout.write(
      `${dim("thinking budget set to")} ${asNumber} ${dim(`tokens (level: ${ctx.thinkingLevel})`)}\n`,
    );
    return;
  }
  if (isThinkingLevel(arg)) {
    ctx.thinkingLevel = arg;
    ctx.thinkingBudgetOverride = undefined;
    await persistThinking(ctx);
    process.stdout.write(`${dim("thinking set to")} ${arg}\n`);
    return;
  }
  process.stdout.write(
    `${red("✗")} ${dim("expected off|low|medium|high|max or a positive integer")}\n`,
  );
}
