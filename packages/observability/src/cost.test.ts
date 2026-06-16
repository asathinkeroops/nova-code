import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_PRICING } from "@nova/runtime";
import {
  computeCost,
  formatMoney,
  resolveModelRates,
  type ModelPrice,
  type ModelRates,
} from "./cost.js";

const RATES: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe("computeCost", () => {
  it("prices each bucket per million tokens and sums the total", () => {
    const cost = computeCost(
      {
        uncachedInputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 500_000,
        outputTokens: 1_000_000,
      },
      RATES,
    );
    expect(cost.input).toBeCloseTo(3, 10); // 1M * $3
    expect(cost.cacheRead).toBeCloseTo(0.6, 10); // 2M * $0.30
    expect(cost.cacheWrite).toBeCloseTo(1.875, 10); // 0.5M * $3.75
    expect(cost.output).toBeCloseTo(15, 10); // 1M * $15
    expect(cost.total).toBeCloseTo(3 + 0.6 + 1.875 + 15, 10);
  });

  it("returns all zeros for zero usage", () => {
    const cost = computeCost(
      { uncachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
      RATES,
    );
    expect(cost).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
  });
});

describe("resolveModelRates", () => {
  const table: ModelPrice[] = [
    { match: "deepseek-reasoner", input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    { match: "deepseek", input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  ];

  it("matches a model id by case-insensitive substring", () => {
    expect(resolveModelRates("DeepSeek-Chat", table)?.input).toBe(0.27);
  });

  it("honors order — specific entries listed before generic win", () => {
    expect(resolveModelRates("deepseek-reasoner", table)?.input).toBe(0.55);
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveModelRates("some-unknown-model", table)).toBeUndefined();
  });
});

describe("DEFAULT_MODEL_PRICING", () => {
  it("prices the CNY-denominated DeepSeek v4 models", () => {
    const flash = resolveModelRates("deepseek-v4-flash", DEFAULT_MODEL_PRICING);
    expect(flash).toMatchObject({ input: 1, output: 2, cacheRead: 0.02, currency: "CNY" });
    const pro = resolveModelRates("deepseek-v4-pro", DEFAULT_MODEL_PRICING);
    expect(pro).toMatchObject({ input: 3, output: 6, cacheRead: 0.025, currency: "CNY" });
  });

  it("returns undefined for ids not in the table", () => {
    expect(resolveModelRates("claude-opus-4-8", DEFAULT_MODEL_PRICING)).toBeUndefined();
    expect(resolveModelRates("deepseek-chat", DEFAULT_MODEL_PRICING)).toBeUndefined();
  });
});

describe("formatMoney", () => {
  it("uses two decimals for cent-and-up amounts", () => {
    expect(formatMoney(1.2345)).toBe("$1.23");
    expect(formatMoney(0.01)).toBe("$0.01");
  });
  it("uses four decimals for sub-cent amounts so they aren't rounded to zero", () => {
    expect(formatMoney(0.0003)).toBe("$0.0003");
  });
  it("renders exact zero as $0.00", () => {
    expect(formatMoney(0)).toBe("$0.00");
  });
  it("clamps negatives to zero", () => {
    expect(formatMoney(-5)).toBe("$0.00");
  });
  it("renders the CNY symbol when that currency is given", () => {
    expect(formatMoney(1.2345, "CNY")).toBe("¥1.23");
    expect(formatMoney(0.0003, "CNY")).toBe("¥0.0003");
  });
});
