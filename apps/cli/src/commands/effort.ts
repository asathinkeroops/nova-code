import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "@nova/core";
import { saveSettings } from "@nova/runtime";
import { dim, PURPLE_HEX, type Rgb } from "../colors.js";
import { thinkingLevelLabel, refreshBanner, type CliContext } from "../context.js";

const TITLE = "/effort";

/**
 * One-line blurb per reasoning depth, shown live under the slider so the tradeoff
 * (speed ↔ depth, and the token cost) is visible while choosing. Keyed by every
 * {@link THINKING_LEVELS} entry.
 */
const LEVEL_BLURB: Record<ThinkingLevel, string> = {
  off: "Extended thinking off — the fastest replies. Best for simple edits and quick questions.",
  low: "Light reasoning (~2k tokens). A small budget for straightforward, single-step tasks.",
  medium: "Balanced reasoning (~8k tokens). A solid default for everyday work.",
  high: "Deep reasoning (~16k tokens). For harder, multi-step problems worth the extra latency.",
  max: "Maximum reasoning (~32k tokens). May use excessive tokens and overthink — use sparingly for the hardest tasks.",
};

/**
 * Highlight colour per depth — a cool→warm gradient tracking the Faster→Smarter
 * scale, so the selected level's tint signals where it sits. `max` is the odd
 * one out: it opts into the slider's rainbow shimmer (see LEVEL_SHIMMER) and its
 * tint here is only the non-truecolor fallback.
 */
const LEVEL_TINT: Record<ThinkingLevel, Rgb> = {
  off: [148, 148, 148], // grey — neutral, lowest effort
  low: [127, 217, 154], // green
  medium: [96, 165, 250], // blue
  high: [255, 140, 50], // orange
  max: [255, 90, 90], // red (fallback; truecolor shimmers instead)
};

/** Reflect the current reasoning depth in the status line + banner. */
function refreshThinkingUi(ctx: CliContext): void {
  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  refreshBanner(ctx);
}

/**
 * Persist a level change into the ACTIVE tier's profile — thinking lives
 * per-tier now, so `/effort <level>` edits `models.<tier>.thinking` and a later
 * /model switch re-seeds from it. A bare model id (not a configured tier) has no
 * profile to write, so it stays session-only. The numeric budget override
 * (ctx.thinkingBudgetOverride) is always session-only — there's no per-tier
 * budget field — so it takes the lighter `refreshThinkingUi` path instead.
 */
async function persistTierThinking(ctx: CliContext): Promise<void> {
  refreshThinkingUi(ctx);
  const tier = ctx.settings.models[ctx.settings.model];
  if (!tier) return;
  tier.thinking = ctx.thinkingLevel;
  try {
    await saveSettings({ models: ctx.settings.models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to save settings: ${msg}`, { kind: "error", title: TITLE });
  }
}

export async function handleEffort(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    const currentIdx = THINKING_LEVELS.indexOf(ctx.thinkingLevel);
    const pick = await ctx.screen.pickSlider<ThinkingLevel>({
      items: [...THINKING_LEVELS],
      leftLabel: "Faster",
      rightLabel: "Smarter",
      footer: dim("← → navigate · enter confirm · esc cancel"),
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      topRuleColor: PURPLE_HEX,
      label: (level) => level,
      description: (level) => LEVEL_BLURB[level],
      tint: (level) => LEVEL_TINT[level],
      shimmer: (level) => level === "max",
    });
    if (!pick) return; // esc — leave the feed quiet
    ctx.thinkingLevel = pick;
    ctx.thinkingBudgetOverride = undefined;
    await persistTierThinking(ctx);
    ctx.screen.card(`${dim("thinking set to")} ${pick}`, { title: TITLE });
    return;
  }

  const asNumber = Number.parseInt(arg, 10);
  if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
    // Session-only numeric budget override (not persisted — no per-tier field).
    ctx.thinkingBudgetOverride = asNumber;
    refreshThinkingUi(ctx);
    ctx.screen.card(
      `${dim("thinking budget set to")} ${asNumber} ${dim(`tokens (level: ${ctx.thinkingLevel}, this session)`)}`,
      { title: TITLE },
    );
    return;
  }
  if (isThinkingLevel(arg)) {
    ctx.thinkingLevel = arg;
    ctx.thinkingBudgetOverride = undefined;
    await persistTierThinking(ctx);
    ctx.screen.card(`${dim("thinking set to")} ${arg}`, { title: TITLE });
    return;
  }
  ctx.screen.card("expected off|low|medium|high|max or a positive integer", {
    kind: "error",
    title: TITLE,
  });
}
