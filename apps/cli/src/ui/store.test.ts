import { describe, it, expect } from "vitest";
import { createAppStore } from "./store.js";

describe("input queue", () => {
  it("delivers immediately when a prompt is already queued", async () => {
    const store = createAppStore();
    store.getState().enqueueInput("hello");
    // No consumer was waiting, so it lands in the visible queue.
    expect(store.getState().inputQueue).toEqual(["hello"]);
    await expect(store.getState().takeInput()).resolves.toBe("hello");
    expect(store.getState().inputQueue).toEqual([]);
  });

  it("blocks until a prompt arrives, then resolves", async () => {
    const store = createAppStore();
    const pending = store.getState().takeInput();
    // Waiter registered → enqueue hands off directly without touching the queue.
    store.getState().enqueueInput("later");
    expect(store.getState().inputQueue).toEqual([]);
    await expect(pending).resolves.toBe("later");
  });

  it("preserves FIFO order across multiple queued prompts", async () => {
    const store = createAppStore();
    store.getState().enqueueInput("one");
    store.getState().enqueueInput("two");
    store.getState().enqueueInput("three");
    expect(store.getState().inputQueue).toEqual(["one", "two", "three"]);
    await expect(store.getState().takeInput()).resolves.toBe("one");
    await expect(store.getState().takeInput()).resolves.toBe("two");
    await expect(store.getState().takeInput()).resolves.toBe("three");
  });

  it("resolves a pending take with null when exit is requested", async () => {
    const store = createAppStore();
    const pending = store.getState().takeInput();
    store.getState().requestExit();
    await expect(pending).resolves.toBeNull();
  });

  it("returns null on the next take when exit was requested while idle", async () => {
    const store = createAppStore();
    store.getState().requestExit();
    await expect(store.getState().takeInput()).resolves.toBeNull();
    // The exit flag is one-shot: a fresh take blocks again.
    let settled = false;
    void store.getState().takeInput().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("drains queued prompts before reporting exit", async () => {
    const store = createAppStore();
    store.getState().enqueueInput("queued");
    store.getState().requestExit();
    // Items already in the queue are consumed first; exit only surfaces once empty.
    await expect(store.getState().takeInput()).resolves.toBe("queued");
    await expect(store.getState().takeInput()).resolves.toBeNull();
  });
});

describe("setSpinnerHint", () => {
  it("is a no-op when no spinner is active", () => {
    const store = createAppStore();
    store.getState().setSpinnerHint("retry 1/3");
    expect(store.getState().spinner).toBeNull();
  });

  it("sets and clears the active spinner's hint", () => {
    const store = createAppStore();
    store.getState().startSpinner("working", "esc to interrupt");
    store.getState().setSpinnerHint("retry 1/3 (429, 1s)");
    expect(store.getState().spinner?.hint).toBe("retry 1/3 (429, 1s)");
    store.getState().setSpinnerHint(undefined);
    expect(store.getState().spinner?.hint).toBeUndefined();
  });
});

describe("live draft", () => {
  it("accumulates text and thinking deltas across calls", () => {
    const store = createAppStore();
    store.getState().appendLiveDraft({ thinking: "rea" });
    store.getState().appendLiveDraft({ thinking: "son" });
    store.getState().appendLiveDraft({ text: "he" });
    store.getState().appendLiveDraft({ text: "llo" });
    expect(store.getState().liveDraft).toEqual({ text: "hello", thinking: "reason" });
  });

  it("ignores empty deltas (no draft is created)", () => {
    const store = createAppStore();
    store.getState().appendLiveDraft({});
    store.getState().appendLiveDraft({ text: "", thinking: "" });
    expect(store.getState().liveDraft).toBeNull();
  });

  it("clears the draft", () => {
    const store = createAppStore();
    store.getState().appendLiveDraft({ text: "partial" });
    store.getState().clearLiveDraft();
    expect(store.getState().liveDraft).toBeNull();
  });

  it("drops the draft on reset", () => {
    const store = createAppStore();
    store.getState().appendLiveDraft({ text: "partial" });
    store.getState().reset();
    expect(store.getState().liveDraft).toBeNull();
  });
});
