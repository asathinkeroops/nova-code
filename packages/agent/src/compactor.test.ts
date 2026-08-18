import { describe, expect, it, vi } from "vitest";
import type { AssistantTurn, MessageParam, ModelClient } from "@nova/core";
import { isCompactionMarker } from "./compact.js";
import { buildCompactor, manualCompact, type BuildCompactorOptions } from "./compactor.js";

function fakeModel(text = "SUMMARY"): ModelClient {
  return {
    call: vi.fn(
      async (): Promise<AssistantTurn> => ({
        content: [{ type: "text", text }],
        stopReason: "end_turn",
      }),
    ),
  };
}

/** A message big enough to blow any threshold used below. */
function bigUser(chars = 4 * 40_000): MessageParam {
  return { role: "user", content: "x".repeat(chars) };
}

function build(over: Partial<BuildCompactorOptions> = {}) {
  return buildCompactor({
    auto: { enabled: true, thresholdTokens: 10_000 },
    getModel: () => fakeModel(),
    getContextWindowSize: () => 200_000,
    ...over,
  });
}

describe("buildCompactor — the auto path", () => {
  it("returns the SAME array reference when auto-compaction is disabled", async () => {
    const messages = [bigUser()];
    const model = fakeModel();
    const c = build({ auto: { enabled: false, thresholdTokens: 10 }, getModel: () => model });
    // Reference equality is how the loop decides nothing happened, so a no-op
    // pass must not even copy the array.
    expect(await c.compact(messages, { reason: "auto" })).toBe(messages);
    expect(model.call).not.toHaveBeenCalled();
  });

  it("returns the same reference when the history is below the threshold", async () => {
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];
    const model = fakeModel();
    const c = build({ getModel: () => model });
    expect(await c.compact(messages, { reason: "auto" })).toBe(messages);
    expect(model.call).not.toHaveBeenCalled();
  });

  it("APPENDS a boundary to the full history instead of replacing it", async () => {
    const messages = [bigUser(), { role: "assistant" as const, content: "ok" }];
    const c = build();
    const next = await c.compact(messages, { reason: "auto" });

    expect(next).not.toBe(messages);
    expect(next).toHaveLength(messages.length + 1);
    expect(next.slice(0, messages.length)).toEqual(messages);
    expect(isCompactionMarker(next[next.length - 1]!)).toBe(true);
    // The model-facing view collapses to just the boundary.
    expect(c.view(next)).toHaveLength(1);
  });

  it("triggers on the model VIEW, not the retained archive", async () => {
    // Post-boundary the archive keeps growing, but only the slice after the last
    // boundary is sent — so a big archive plus a small tail must NOT re-trigger.
    const compacted = await build().compact([bigUser()], { reason: "auto" });
    const withTail: MessageParam[] = [...compacted, { role: "user", content: "hi" }];
    const model = fakeModel();
    const c = build({ getModel: () => model });
    expect(await c.compact(withTail, { reason: "auto" })).toBe(withTail);
    expect(model.call).not.toHaveBeenCalled();
  });

  it("counts fixed overhead against the threshold", async () => {
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];
    const opts = { auto: { enabled: true, thresholdTokens: 10_000 } };
    expect(await build(opts).compact(messages, { reason: "auto" })).toBe(messages);

    const c = build({ ...opts, getOverheadTokens: () => 20_000 });
    expect(await c.compact(messages, { reason: "auto" })).not.toBe(messages);
  });

  it("prefers the request's overheadTokens over the getter", async () => {
    const getOverheadTokens = vi.fn(() => 20_000);
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];
    const c = build({ getOverheadTokens });
    // The loop measured 0 for this request; the getter must not override it.
    expect(await c.compact(messages, { reason: "auto", overheadTokens: 0 })).toBe(messages);
    expect(getOverheadTokens).not.toHaveBeenCalled();
  });

  it("reads the context window per call so a /model switch is honored", async () => {
    let window = 4_000_000;
    const messages = [bigUser()];
    const c = build({
      auto: { enabled: true },
      getContextWindowSize: () => window,
    });
    expect(await c.compact(messages, { reason: "auto" })).toBe(messages);
    window = 32_000;
    expect(await c.compact(messages, { reason: "auto" })).not.toBe(messages);
  });

  it("lets a PreCompact veto cancel the pass without calling the summarizer", async () => {
    const model = fakeModel();
    const messages = [bigUser()];
    const c = build({ getModel: () => model, onPreCompact: () => ({ block: true }) });
    expect(await c.compact(messages, { reason: "auto" })).toBe(messages);
    expect(model.call).not.toHaveBeenCalled();
  });

  it("reports before/after only when a boundary was actually appended", async () => {
    const onAutoCompact = vi.fn();
    const c = build({ onAutoCompact });
    await c.compact([{ role: "user", content: "hi" }], { reason: "auto" });
    expect(onAutoCompact).not.toHaveBeenCalled();

    await c.compact([bigUser(), bigUser()], { reason: "auto" });
    expect(onAutoCompact).toHaveBeenCalledWith({ before: 2, after: 1 });
  });

  it("forwards the summary cap to the summarizer", async () => {
    const model = fakeModel();
    const c = build({
      auto: { enabled: true, thresholdTokens: 10_000, maxSummaryTokens: 123 },
      getModel: () => model,
    });
    await c.compact([bigUser()], { reason: "auto" });
    expect(vi.mocked(model.call).mock.calls[0]?.[0]?.maxTokens).toBe(123);
  });
});

describe("buildCompactor — the manual path", () => {
  it("compacts regardless of `enabled` and of the threshold", async () => {
    const c = build({ auto: { enabled: false, thresholdTokens: 10_000_000 } });
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];
    const next = await c.compact(messages, { reason: "manual" });
    expect(next).toHaveLength(2);
    expect(isCompactionMarker(next[1]!)).toBe(true);
  });

  it("is not vetoable by the auto-path PreCompact hook and fires no auto notice", async () => {
    const onPreCompact = vi.fn(() => ({ block: true }));
    const onAutoCompact = vi.fn();
    const c = build({ onPreCompact, onAutoCompact });
    const next = await c.compact([{ role: "user", content: "hi" }], { reason: "manual" });
    expect(next).toHaveLength(2);
    expect(onPreCompact).not.toHaveBeenCalled();
    expect(onAutoCompact).not.toHaveBeenCalled();
  });

  it("forwards a focus hint to the summarizer", async () => {
    const model = fakeModel();
    const c = build({ getModel: () => model });
    await c.compact([{ role: "user", content: "hi" }], { reason: "manual", focus: "the parser" });
    const sent = vi.mocked(model.call).mock.calls[0]?.[0]?.messages[0]?.content;
    expect(typeof sent === "string" && sent.includes("Focus on: the parser")).toBe(true);
  });
});

describe("manualCompact", () => {
  it("reports the model-view compression around the session's own port", async () => {
    const c = build();
    const messages: MessageParam[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    const r = await manualCompact(messages, { compactor: c });

    // `before`/`after` describe the MODEL view; the returned history is the full
    // append-only array plus the boundary.
    expect(r.before).toBe(3);
    expect(r.after).toBe(1);
    expect(r.messages).toHaveLength(4);
    expect(r.messages.slice(0, 3)).toEqual(messages);
  });

  it("measures `before` against the last boundary, not the whole archive", async () => {
    const first = await manualCompact([{ role: "user", content: "one" }], { compactor: build() });
    const grown = [...first.messages, { role: "user" as const, content: "two" }];
    const second = await manualCompact(grown, { compactor: build() });
    expect(second.before).toBe(2);
    expect(second.after).toBe(1);
  });

  it("passes the focus hint through to the summarizer", async () => {
    const model = fakeModel();
    await manualCompact([{ role: "user", content: "hi" }], {
      compactor: build({ getModel: () => model }),
      focus: "auth flow",
    });
    const sent = vi.mocked(model.call).mock.calls[0]?.[0]?.messages[0]?.content;
    expect(typeof sent === "string" && sent.includes("Focus on: auth flow")).toBe(true);
  });
});
