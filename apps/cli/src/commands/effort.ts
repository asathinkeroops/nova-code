import {
  isThinkingLevel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@nova/runtime";
import { saveModelProfileOverride } from "@nova/runtime";
import { ACCENT_HEX, dim, type Rgb } from "../colors.js";
import { thinkingLevelLabel, refreshBanner, type CliContext } from "../context.js";
import { t } from "../i18n/index.js";

const TITLE = "/effort";

/**
 * One-line blurb per reasoning depth, shown live under the slider so the tradeoff
 * (speed ↔ depth, and the token cost) is visible while choosing. Read from the
 * i18n catalog at call time (see the i18n invariant), keyed by every
 * {@link THINKING_LEVELS} entry.
 */
function levelBlurb(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return t.effort.blurbOff;
    case "low":
      return t.effort.blurbLow;
    case "medium":
      return t.effort.blurbMedium;
    case "high":
      return t.effort.blurbHigh;
    case "max":
      return t.effort.blurbMax;
  }
}

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
 *
 * Only the `thinking` field is written: `ctx.settings.models` is the RESOLVED
 * table (provider built-ins already merged in), so persisting it wholesale would
 * freeze today's model ids / prices / limits into nova.config.json and cut the
 * install off from future default updates.
 */
async function persistTierThinking(ctx: CliContext): Promise<void> {
  refreshThinkingUi(ctx);
  const tier = ctx.settings.models[ctx.settings.model];
  if (!tier) return;
  tier.thinking = ctx.thinkingLevel;
  try {
    await saveModelProfileOverride(ctx.settings.model, { thinking: ctx.thinkingLevel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(t.effort.saveFailed(msg), { kind: "error", title: TITLE });
  }
}

export async function handleEffort(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    const currentIdx = THINKING_LEVELS.indexOf(ctx.thinkingLevel);
    const pick = await ctx.screen.pickSlider<ThinkingLevel>({
      items: [...THINKING_LEVELS],
      leftLabel: t.effort.faster,
      rightLabel: t.effort.smarter,
      footer: dim(t.effort.footer),
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      topRuleColor: ACCENT_HEX,
      label: (level) => level,
      description: (level) => levelBlurb(level),
      tint: (level) => LEVEL_TINT[level],
      shimmer: (level) => level === "max",
    });
    if (!pick) return; // esc — leave the feed quiet
    ctx.thinkingLevel = pick;
    ctx.thinkingBudgetOverride = undefined;
    await persistTierThinking(ctx);
    ctx.screen.card(`${dim(t.effort.setTo)} ${pick}`, { title: TITLE });
    return;
  }

  const asNumber = Number.parseInt(arg, 10);
  if (Number.isFinite(asNumber) && asNumber > 0 && String(asNumber) === arg) {
    // Session-only numeric budget override (not persisted — no per-tier field).
    ctx.thinkingBudgetOverride = asNumber;
    refreshThinkingUi(ctx);
    ctx.screen.card(
      `${dim(t.effort.budgetSetTo)} ${asNumber} ${dim(t.effort.budgetSuffix(ctx.thinkingLevel))}`,
      { title: TITLE },
    );
    return;
  }
  if (isThinkingLevel(arg)) {
    ctx.thinkingLevel = arg;
    ctx.thinkingBudgetOverride = undefined;
    await persistTierThinking(ctx);
    ctx.screen.card(`${dim(t.effort.setTo)} ${arg}`, { title: TITLE });
    return;
  }
  ctx.screen.card(t.effort.expected, {
    kind: "error",
    title: TITLE,
  });
}
