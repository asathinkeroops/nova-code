// Discrete thinking "levels" map to Anthropic's `budget_tokens` knob.
// `off` means do not enable extended thinking at all.
export const THINKING_BUDGETS = {
  off: 0,
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  max: 32_000,
} as const;

export type ThinkingLevel = keyof typeof THINKING_BUDGETS;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the effective budget. An explicit override (any positive integer)
 * always wins over the level mapping, letting power users dial in a custom
 * value without inventing a new level.
 */
export function resolveBudget(level: ThinkingLevel, override?: number): number {
  if (typeof override === "number" && override > 0) return Math.floor(override);
  return THINKING_BUDGETS[level];
}
