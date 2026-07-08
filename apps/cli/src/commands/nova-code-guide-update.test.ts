import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../guide/provisioner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../guide/provisioner.js")>("../guide/provisioner.js");
  return { ...actual, ensureFresh: vi.fn() };
});

import type { CliContext } from "../context.js";
import { ensureFresh } from "../guide/provisioner.js";
import { handleNovaCodeGuideUpdate } from "./nova-code-guide-update.js";

const mockEnsure = vi.mocked(ensureFresh);

let cards: string[];

function makeCtx(guideOverrides: Record<string, unknown> = {}, subagentEnabled = true): CliContext {
  cards = [];
  return {
    workspace: "/some/workspace",
    settings: {
      subagent: { enabled: subagentEnabled },
      guide: {
        enabled: true,
        source: "remote",
        repoUrl: "https://example.com/nova.git",
        ref: "main",
        cacheDir: "~/.nova/nova-code-guide",
        refreshIntervalHours: 24,
        ...guideOverrides,
      },
    },
    screen: {
      card: (text: string) => cards.push(text),
      startSpinner: () => ({ stop() {} }),
    },
    logger: { debug() {}, warn() {}, info() {} },
  } as unknown as CliContext;
}

beforeEach(() => {
  mockEnsure.mockReset();
  mockEnsure.mockResolvedValue({
    dir: "/home/u/.nova/nova-code-guide",
    refreshed: true,
    offline: false,
  });
});

describe("handleNovaCodeGuideUpdate", () => {
  it("errors when sub-agents are disabled", async () => {
    const res = await handleNovaCodeGuideUpdate(makeCtx({}, false));
    expect(res).toEqual({
      kind: "error",
      message: expect.stringMatching(/sub-agents are disabled/),
    });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("errors when the guide is disabled", async () => {
    const res = await handleNovaCodeGuideUpdate(makeCtx({ enabled: false }));
    expect(res).toEqual({ kind: "error", message: expect.stringMatching(/disabled/) });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("force-fetches (no TTL) and reports success in remote mode", async () => {
    const res = await handleNovaCodeGuideUpdate(makeCtx());
    // A manual update must ignore the freshness window, so no maxAgeMs is passed.
    expect(mockEnsure).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://example.com/nova.git", ref: "main" }),
    );
    expect(mockEnsure.mock.calls[0]?.[0]).not.toHaveProperty("maxAgeMs");
    expect(res).toEqual({ kind: "handled" });
    expect(cards.some((c) => /Updated/i.test(c))).toBe(true);
  });

  it("reports offline reuse when the fetch fails but a checkout exists", async () => {
    mockEnsure.mockResolvedValue({ dir: "/cache/guide", refreshed: false, offline: true });
    const res = await handleNovaCodeGuideUpdate(makeCtx());
    expect(res).toEqual({ kind: "handled" });
    expect(cards.some((c) => /Offline/i.test(c))).toBe(true);
  });

  it("surfaces an initial-clone failure with recovery guidance", async () => {
    mockEnsure.mockRejectedValue(new Error("failed to clone the Nova source"));
    const res = await handleNovaCodeGuideUpdate(makeCtx());
    expect(res.kind).toBe("error");
    if (res.kind !== "error") throw new Error("expected error outcome");
    expect(res.message).toMatch(/could not update the Nova source: failed to clone/);
    expect(res.message).toMatch(/\/nova-code-guide-update/);
    expect(res.message).toMatch(/settings\.guide\.source.*local/);
  });

  it("does not fetch in local mode; reports the source dir", async () => {
    const res = await handleNovaCodeGuideUpdate(makeCtx({ source: "local", localPath: "/tmp/nova" }));
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: "handled" });
    expect(cards.some((c) => /Local mode/i.test(c))).toBe(true);
  });
});
