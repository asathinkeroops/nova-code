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

describe("takeQueuedPrompt (pre_continue mid-task consumption)", () => {
  it("consumes and trims a plain model-bound prompt from the head", () => {
    const store = createAppStore();
    store.getState().enqueueInput("  build the thing  ");
    expect(store.getState().takeQueuedPrompt()).toBe("build the thing");
    expect(store.getState().inputQueue).toEqual([]);
  });

  it("returns null on an empty queue", () => {
    const store = createAppStore();
    expect(store.getState().takeQueuedPrompt()).toBeNull();
  });

  it("leaves slash and shell lines queued for the REPL", () => {
    const store = createAppStore();
    store.getState().enqueueInput("/clear");
    expect(store.getState().takeQueuedPrompt()).toBeNull();
    expect(store.getState().inputQueue).toEqual(["/clear"]);

    const shell = createAppStore();
    shell.getState().enqueueInput("!ls");
    expect(shell.getState().takeQueuedPrompt()).toBeNull();
    expect(shell.getState().inputQueue).toEqual(["!ls"]);
  });

  it("does not skip past a leading slash line to reach a later prompt", () => {
    const store = createAppStore();
    store.getState().enqueueInput("/model");
    store.getState().enqueueInput("keep going");
    // Only the head is considered; the slash command must be dispatched first.
    expect(store.getState().takeQueuedPrompt()).toBeNull();
    expect(store.getState().inputQueue).toEqual(["/model", "keep going"]);
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

describe("permission mode", () => {
  it("starts in auto mode", () => {
    expect(createAppStore().getState().permissionMode).toBe("auto");
  });

  it("cycles auto → plan → default → acceptEdits → auto and returns the new mode", () => {
    const store = createAppStore();
    expect(store.getState().cyclePermissionMode()).toBe("plan");
    expect(store.getState().permissionMode).toBe("plan");
    expect(store.getState().cyclePermissionMode()).toBe("default");
    expect(store.getState().cyclePermissionMode()).toBe("acceptEdits");
    expect(store.getState().cyclePermissionMode()).toBe("auto");
  });

  it("survives reset (/clear) like the input placeholder", () => {
    const store = createAppStore();
    store.getState().cyclePermissionMode(); // → plan
    store.getState().reset();
    expect(store.getState().permissionMode).toBe("plan");
  });

  it("setPermissionMode seeds the mode directly (e.g. from --permission-mode)", () => {
    const store = createAppStore();
    store.getState().setPermissionMode("plan");
    expect(store.getState().permissionMode).toBe("plan");
  });
});

describe("modeBeforePlan (where approving a plan returns you to)", () => {
  it("is null until plan mode is entered", () => {
    expect(createAppStore().getState().modeBeforePlan).toBeNull();
  });

  it("records the previous mode on both ways into plan mode", () => {
    // shift+tab, from the auto start.
    const cycled = createAppStore();
    cycled.getState().cyclePermissionMode();
    expect(cycled.getState().modeBeforePlan).toBe("auto");

    // enterPlanMode / --permission-mode plan, from a mode the user picked.
    const set = createAppStore();
    set.getState().setPermissionMode("acceptEdits");
    set.getState().setPermissionMode("plan");
    expect(set.getState().modeBeforePlan).toBe("acceptEdits");
  });

  it("clears on the way out so a stale mode can never be restored", () => {
    const store = createAppStore();
    store.getState().setPermissionMode("plan");
    store.getState().setPermissionMode("auto");
    expect(store.getState().modeBeforePlan).toBeNull();
    // …and cycling on past plan clears it too.
    store.getState().cyclePermissionMode(); // auto → plan
    expect(store.getState().modeBeforePlan).toBe("auto");
    store.getState().cyclePermissionMode(); // plan → default
    expect(store.getState().modeBeforePlan).toBeNull();
  });

  it("is not disturbed by a mode change that never touches plan", () => {
    const store = createAppStore();
    store.getState().setPermissionMode("acceptEdits");
    expect(store.getState().modeBeforePlan).toBeNull();
  });
});

describe("bypass permissions mode", () => {
  it("is not armed by default and stays out of the cycle", () => {
    const store = createAppStore();
    expect(store.getState().bypassAllowed).toBe(false);
    store.getState().cyclePermissionMode(); // plan — bypass would come next when armed
    expect(store.getState().cyclePermissionMode()).toBe("default"); // skips bypass
  });

  it("enableBypass arms the cycle and switches into bypass mode", () => {
    const store = createAppStore();
    store.getState().enableBypass();
    expect(store.getState().bypassAllowed).toBe(true);
    expect(store.getState().permissionMode).toBe("bypassPermissions");
  });

  it("once armed, shift+tab can cycle into and back out of bypass", () => {
    const store = createAppStore();
    store.getState().enableBypass(); // now in bypassPermissions
    // bypass → default → acceptEdits → auto → plan → bypass
    expect(store.getState().cyclePermissionMode()).toBe("default");
    expect(store.getState().cyclePermissionMode()).toBe("acceptEdits");
    expect(store.getState().cyclePermissionMode()).toBe("auto");
    expect(store.getState().cyclePermissionMode()).toBe("plan");
    expect(store.getState().cyclePermissionMode()).toBe("bypassPermissions");
  });

  it("the armed cycle survives reset (/clear)", () => {
    const store = createAppStore();
    store.getState().enableBypass();
    store.getState().cyclePermissionMode(); // → default, but still armed
    store.getState().reset();
    expect(store.getState().bypassAllowed).toBe(true);
    expect(store.getState().cyclePermissionMode()).toBe("acceptEdits");
    store.getState().cyclePermissionMode(); // auto
    store.getState().cyclePermissionMode(); // plan
    expect(store.getState().cyclePermissionMode()).toBe("bypassPermissions");
  });
});

describe("checklist footers", () => {
  // Both stores hand back a freshly cloned array on every read, and the CLI
  // re-reads them on every post_messages (~2N+3 times per turn). Publishing a
  // new reference each time re-renders the whole Viewport for nothing.
  const todos = () => [{ id: "t1", description: "do it", status: "pending" as const }];
  const tasks = () => [
    { id: "k1", description: "ship it", blockedBy: ["k0"], status: "pending" as const },
  ];

  it("ignores a todo list that is equal in value to the current one", () => {
    const store = createAppStore();
    store.getState().setTodos(todos());
    const first = store.getState().todos;
    store.getState().setTodos(todos());
    expect(store.getState().todos).toBe(first);
  });

  it("publishes a todo list whose status changed", () => {
    const store = createAppStore();
    store.getState().setTodos(todos());
    const first = store.getState().todos;
    store.getState().setTodos([{ id: "t1", description: "do it", status: "completed" }]);
    expect(store.getState().todos).not.toBe(first);
    expect(store.getState().todos[0]).toMatchObject({ status: "completed" });
  });

  it("ignores a task list that is equal in value to the current one", () => {
    const store = createAppStore();
    store.getState().setTasks(tasks());
    const first = store.getState().tasks;
    store.getState().setTasks(tasks());
    expect(store.getState().tasks).toBe(first);
  });

  it("publishes a task list whose blockedBy changed", () => {
    const store = createAppStore();
    store.getState().setTasks(tasks());
    const first = store.getState().tasks;
    store
      .getState()
      .setTasks([{ id: "k1", description: "ship it", blockedBy: [], status: "pending" }]);
    expect(store.getState().tasks).not.toBe(first);
  });

  it("publishes a list that gained or lost an entry", () => {
    const store = createAppStore();
    store.getState().setTodos(todos());
    const first = store.getState().todos;
    store
      .getState()
      .setTodos([...todos(), { id: "t2", description: "and this", status: "pending" }]);
    expect(store.getState().todos).not.toBe(first);
    expect(store.getState().todos).toHaveLength(2);
  });
});
