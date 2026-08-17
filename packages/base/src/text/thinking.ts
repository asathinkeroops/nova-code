// Discrete thinking "levels" map to Anthropic's `budget_tokens` knob.
// `off` means do not enable extended thinking at all.
export const THINKING_BUDGETS = {
  off: 0,
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  max: 32_000,
} as const;

/**
 * The level union is the config schema's (`thinkingLevelSchema`) — this module
 * only maps it to a token budget, so the two can never drift.
 */
export type { ThinkingLevel } from "../config/config.js";

export const THINKING_LEVELS: readonly (keyof typeof THINKING_BUDGETS)[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

export function isThinkingLevel(value: string): value is keyof typeof THINKING_BUDGETS {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the effective budget. An explicit override (any positive integer)
 * always wins over the level mapping, letting power users dial in a custom
 * value without inventing a new level.
 */
export function resolveBudget(
  level: keyof typeof THINKING_BUDGETS,
  override?: number,
): number {
  if (typeof override === "number" && override > 0) return Math.floor(override);
  return THINKING_BUDGETS[level];
}
