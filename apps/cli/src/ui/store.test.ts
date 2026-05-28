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
