import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../guide/provisioner.js", async () => {
  const actual =
    await vi.importActual<typeof import("../guide/provisioner.js")>("../guide/provisioner.js");
  return { ...actual, ensureFresh: vi.fn() };
});

import { NOVA_GUIDE_AGENT } from "../guide/agent.js";
import type { CliContext } from "../context.js";
import { ensureFresh } from "../guide/provisioner.js";
import { handleNovaCodeGuide } from "./nova-code-guide.js";

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

describe("handleNovaCodeGuide", () => {
  it("errors when sub-agents are disabled", async () => {
    const res = await handleNovaCodeGuide(makeCtx({}, false), "how does X work");
    expect(res).toEqual({
      kind: "error",
      message: expect.stringMatching(/sub-agents are disabled/),
    });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("errors when the guide is disabled", async () => {
    const res = await handleNovaCodeGuide(makeCtx({ enabled: false }), "how does X work");
    expect(res).toEqual({ kind: "error", message: expect.stringMatching(/disabled/) });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("errors on an empty question", async () => {
    const res = await handleNovaCodeGuide(makeCtx(), "   ");
    expect(res).toEqual({ kind: "error", message: expect.stringMatching(/usage:/) });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("provisions (remote) then returns a prompt naming the guide sub-agent and the question", async () => {
    const res = await handleNovaCodeGuide(makeCtx(), "how does compaction work?");
    expect(mockEnsure).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://example.com/nova.git", ref: "main" }),
    );
    expect(res.kind).toBe("prompt");
    if (res.kind !== "prompt") throw new Error("expected prompt outcome");
    expect(res.text).toContain(NOVA_GUIDE_AGENT);
    expect(res.text).toContain("how does compaction work?");
  });

  it("notes offline reuse but still returns a prompt (remote)", async () => {
    mockEnsure.mockResolvedValue({ dir: "/cache/guide", refreshed: false, offline: true });
    const res = await handleNovaCodeGuide(makeCtx(), "q");
    expect(res.kind).toBe("prompt");
    expect(cards.some((c) => /Offline/i.test(c))).toBe(true);
  });

  it("surfaces a provisioning failure as an error (remote)", async () => {
    mockEnsure.mockRejectedValue(new Error("git not found"));
    const res = await handleNovaCodeGuide(makeCtx(), "q");
    expect(res).toEqual({
      kind: "error",
      message: expect.stringMatching(/could not prepare the Nova source: git not found/),
    });
  });

  it("reads a local source dir without provisioning (local mode)", async () => {
    // tmpdir() exists, so the local-source check passes.
    const res = await handleNovaCodeGuide(
      makeCtx({ source: "local", localPath: tmpdir() }),
      "how does the loop work?",
    );
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(res.kind).toBe("prompt");
    if (res.kind !== "prompt") throw new Error("expected prompt outcome");
    expect(res.text).toContain(NOVA_GUIDE_AGENT);
    expect(cards.some((c) => /local Nova source/i.test(c))).toBe(true);
  });

  it("errors when the local source dir is missing (local mode)", async () => {
    const missing = join(tmpdir(), "nova-code-guide-missing-xyz");
    const res = await handleNovaCodeGuide(makeCtx({ source: "local", localPath: missing }), "q");
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(res).toEqual({
      kind: "error",
      message: expect.stringMatching(/local Nova source not found/),
    });
  });
});
