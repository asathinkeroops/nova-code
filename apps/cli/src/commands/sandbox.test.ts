import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@nova/runtime";
import type { CliContext } from "../context.js";

const saveSettings = vi.fn(async (_patch: Partial<Settings>) => {});
vi.mock("@nova/runtime", async (importActual) => ({
  ...(await importActual<typeof import("@nova/runtime")>()),
  saveSettings,
}));

const { handleSandbox } = await import("./sandbox.js");

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}

function makeCtx(cards: Card[], opts: { active?: boolean; reason?: string } = {}) {
  const setSandbox = vi.fn(async (enabled: boolean) => {
    ctx.settings.sandbox.enabled = enabled;
    return { active: opts.active ?? enabled, ...(opts.reason ? { reason: opts.reason } : {}) };
  });
  const ctx = {
    settings: { sandbox: { enabled: false, monitorViolations: true } },
    spinner: null,
    setSandbox,
    screen: {
      startSpinner: () => ({ stop: () => {} }),
      card: (text: string, o: Card["opts"] = {}) => cards.push({ text, opts: o }),
    },
  } as unknown as CliContext;
  return { ctx, setSandbox };
}

beforeEach(() => {
  saveSettings.mockClear();
  saveSettings.mockResolvedValue(undefined);
});

describe("handleSandbox", () => {
  it("persists sandbox.enabled=true to config on /sandbox on", async () => {
    const cards: Card[] = [];
    const { ctx } = makeCtx(cards);
    await handleSandbox(ctx, "on");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]![0]).toEqual({
      sandbox: { enabled: true, monitorViolations: true },
    });
  });

  it("persists sandbox.enabled=false to config on /sandbox off", async () => {
    const cards: Card[] = [];
    const { ctx } = makeCtx(cards);
    ctx.settings.sandbox.enabled = true;
    await handleSandbox(ctx, "off");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings.mock.calls[0]![0]).toEqual({
      sandbox: { enabled: false, monitorViolations: true },
    });
  });

  it("does not write config when just reporting status", async () => {
    const cards: Card[] = [];
    const { ctx } = makeCtx(cards);
    await handleSandbox(ctx, "");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("does not write config on an unknown argument", async () => {
    const cards: Card[] = [];
    const { ctx } = makeCtx(cards);
    await handleSandbox(ctx, "maybe");
    expect(saveSettings).not.toHaveBeenCalled();
    expect(cards.some((c) => c.opts.kind === "error")).toBe(true);
  });

  it("warns but does not throw when persisting fails", async () => {
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const cards: Card[] = [];
    const { ctx } = makeCtx(cards);
    await handleSandbox(ctx, "on");
    expect(cards.some((c) => c.opts.kind === "warn" && c.text.includes("disk full"))).toBe(true);
  });
});
