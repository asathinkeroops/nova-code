import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings, type Settings } from "@nova/base";
import type { CliContext } from "../context.js";

const { saveSettings, refreshBanner, refreshBalance } = vi.hoisted(() => ({
  saveSettings: vi.fn(async () => {}),
  refreshBanner: vi.fn(),
  refreshBalance: vi.fn(async () => {}),
}));
vi.mock("@nova/base", async (importActual) => ({
  ...(await importActual<typeof import("@nova/base")>()),
  saveSettings,
}));

vi.mock("../context.js", () => ({
  refreshBanner,
  refreshBalance,
  thinkingLevelLabel: (ctx: CliContext) =>
    ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
}));

const { handleConnect } = await import("./connect.js");
const priorApiKey = process.env.NOVA_API_KEY;

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}

interface Viewer {
  lines: string[];
}

const tiers = (prefix: string, thinking: "low" | "high" = "low") => ({
  lite: { id: `${prefix}-lite`, thinking: "low" as const },
  pro: { id: `${prefix}-pro`, thinking },
  max: { id: `${prefix}-max`, thinking: "max" as const },
});

function configuredSettings(extra: Record<string, unknown> = {}): Settings {
  return parseSettings({
    providers: [
      {
        name: "alpha",
        profile: "generic",
        apiKey: "key-alpha",
        models: { ...tiers("alpha"), special: { id: "alpha-special", thinking: "medium" } },
      },
      {
        name: "beta",
        profile: "generic",
        apiKey: "key-beta",
        models: tiers("beta", "high"),
      },
    ],
    currentProvider: "alpha",
    model: "special",
    ...extra,
  });
}

function makeCtx(settings = configuredSettings()) {
  const cards: Card[] = [];
  const viewers: Viewer[] = [];
  const built: Array<{ name: string; tracked: boolean }> = [];
  const pickOne = vi.fn(async () => null as string | null);
  const setThinkingLabel = vi.fn();
  const setAccountBalance = vi.fn();
  const oldModel = { call: vi.fn() };
  const oldPredictModel = { call: vi.fn() };
  const ctx = {
    settings,
    apiKey: "key-alpha",
    model: oldModel,
    predictModel: oldPredictModel,
    thinkingLevel: "medium",
    buildModel: (name: string, trackTokens = true) => {
      built.push({ name, tracked: trackTokens });
      return { call: vi.fn() };
    },
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      viewer: async (opts: Viewer) => viewers.push({ lines: opts.lines }),
      pickOne,
      setThinkingLabel,
      setAccountBalance,
    },
  } as unknown as CliContext;
  return {
    ctx,
    cards,
    viewers,
    built,
    pickOne,
    setThinkingLabel,
    setAccountBalance,
    oldModel,
    oldPredictModel,
  };
}

beforeEach(() => {
  delete process.env.NOVA_API_KEY;
  saveSettings.mockClear();
  saveSettings.mockResolvedValue(undefined);
  refreshBanner.mockClear();
  refreshBalance.mockClear();
});

afterEach(() => {
  if (priorApiKey === undefined) delete process.env.NOVA_API_KEY;
  else process.env.NOVA_API_KEY = priorApiKey;
});

describe("handleConnect", () => {
  it("switches to an exact configured name and falls back to pro when needed", async () => {
    const state = makeCtx();
    await handleConnect(state.ctx, "beta");

    expect(saveSettings).toHaveBeenCalledWith({ currentProvider: "beta", model: "pro" });
    expect(state.ctx.settings.currentProvider).toBe("beta");
    expect(state.ctx.settings.model).toBe("pro");
    expect(state.ctx.apiKey).toBe("key-beta");
    expect(state.ctx.model).not.toBe(state.oldModel);
    expect(state.ctx.predictModel).not.toBe(state.oldPredictModel);
    expect(state.built).toEqual([
      { name: "pro", tracked: true },
      { name: "pro", tracked: false },
    ]);
    expect(state.ctx.thinkingLevel).toBe("high");
    expect(state.setThinkingLabel).toHaveBeenCalledWith("high");
    expect(state.setAccountBalance).toHaveBeenCalledWith(null);
    expect(refreshBanner).toHaveBeenCalledWith(state.ctx);
    expect(refreshBalance).toHaveBeenCalledWith(state.ctx);
    expect(state.cards.at(-1)?.text).toContain("connected to beta");
  });

  it("rejects unknown, partial, and case-mismatched names without changing state", async () => {
    for (const name of ["bet", "Beta", "beta extra"]) {
      const state = makeCtx();
      await handleConnect(state.ctx, name);
      expect(state.ctx.settings.currentProvider).toBe("alpha");
      expect(state.built).toEqual([]);
      expect(state.viewers[0]?.lines.join("\n")).toContain(`unknown provider connection "${name}"`);
      expect(state.viewers[0]?.lines.join("\n")).toContain("alpha, beta");
    }
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("opens a provider picker when no name is supplied", async () => {
    const state = makeCtx(configuredSettings({ model: "pro" }));
    state.pickOne.mockResolvedValueOnce("beta");
    await handleConnect(state.ctx, "");

    expect(state.pickOne).toHaveBeenCalledWith(
      expect.objectContaining({
        items: ["alpha", "beta"],
        initialIndex: 0,
      }),
    );
    expect(state.ctx.settings.currentProvider).toBe("beta");
    expect(saveSettings).toHaveBeenCalledWith({ currentProvider: "beta" });
  });

  it("refuses a configured connection that is not usable", async () => {
    const settings = configuredSettings();
    settings.providers[1]!.apiKey = undefined;
    const missingKey = makeCtx(settings);
    await handleConnect(missingKey.ctx, "beta");
    expect(missingKey.viewers[0]?.lines[0]).toContain("has no API key");

    settings.providers[1]!.apiKey = "key-beta";
    settings.providers[1]!.transport = "openai";
    const missingBaseUrl = makeCtx(settings);
    await handleConnect(missingBaseUrl.ctx, "beta");
    expect(missingBaseUrl.viewers[0]?.lines[0]).toContain("missing the baseURL");

    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("rejects missing and incomplete model tables before switching", async () => {
    const settings = configuredSettings();
    settings.providers[1]!.models = {};
    const empty = makeCtx(settings);
    await handleConnect(empty.ctx, "beta");
    expect(empty.viewers[0]?.lines[0]).toContain("no configured model tiers");

    const incompleteSettings = configuredSettings();
    incompleteSettings.providers[1]!.models = {
      pro: incompleteSettings.providers[1]!.models.pro!,
    };
    const incomplete = makeCtx(incompleteSettings);
    await handleConnect(incomplete.ctx, "beta");
    expect(incomplete.viewers[0]?.lines[0]).toContain("missing required model tiers: lite, max");

    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("rolls live state back when persistence fails", async () => {
    const state = makeCtx(configuredSettings({ model: "pro" }));
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    await handleConnect(state.ctx, "beta");

    expect(state.ctx.settings.currentProvider).toBe("alpha");
    expect(state.ctx.settings.model).toBe("pro");
    expect(state.ctx.apiKey).toBe("key-alpha");
    expect(state.ctx.model).toBe(state.oldModel);
    expect(state.cards.at(-1)).toMatchObject({ opts: { kind: "error" } });
    expect(state.cards.at(-1)?.text).toContain("disk full");
    expect(refreshBanner).not.toHaveBeenCalled();
  });

  it("does not rebuild or persist an already-active connection", async () => {
    const state = makeCtx();
    await handleConnect(state.ctx, "alpha");
    expect(state.built).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(state.cards.at(-1)?.text).toContain("already connected to alpha");
  });
});
