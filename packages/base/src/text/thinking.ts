import type { ThinkingLevel } from "../config/config.js";

export type { ThinkingLevel } from "../config/config.js";

/** Provider-neutral reasoning levels in UI order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "auto",
  "off",
  "low",
  "medium",
  "high",
  "max",
];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}
