import { mkdtemp, readFile, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { InvariantsCheck, ToolHandler, ToolUseBlock } from "@nova/core";
import { createDispatcher } from "./dispatcher.js";
import { editTool } from "./edit.js";
import { fileExecutionKey } from "./file-execution.js";
import { readTool } from "./read.js";
import { ToolRegistry } from "./registry.js";
import { writeTool } from "./write.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function use(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function keyedHandler(run: ToolHandler["run"]): ToolHandler {
  return {
    definition: {
      name: "keyed",
      description: "test keyed execution",
      inputSchema: z.object({ key: z.string(), label: z.string() }),
    },
    executionKey(input) {
      return (input as { key: string }).key;
    },
    run,
  };
}

describe("dispatcher · keyed serialization", () => {
  it("serializes calls with the same key", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const starts: string[] = [];
    const handler = keyedHandler(async (raw) => {
      const { label } = raw as { label: string };
      starts.push(label);
      if (label === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { output: label };
    });
    const dispatch = createDispatcher({ registry: new ToolRegistry().register(handler) });

    const first = dispatch(use("u1", "keyed", { key: "same", label: "first" }), {
      cwd: "/tmp",
    });
    await firstStarted.promise;
    const second = dispatch(use("u2", "keyed", { key: "same", label: "second" }), {
      cwd: "/tmp",
    });
    await flushTasks();

    expect(starts).toEqual(["first"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("keeps different keys concurrent", async () => {
    const bothStarted = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const handler = keyedHandler(async (raw) => {
      const { label } = raw as { label: string };
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothStarted.resolve();
      await release.promise;
      active -= 1;
      return { output: label };
    });
    const dispatch = createDispatcher({ registry: new ToolRegistry().register(handler) });

    const calls = [
      dispatch(use("u1", "keyed", { key: "a", label: "first" }), { cwd: "/tmp" }),
      dispatch(use("u2", "keyed", { key: "b", label: "second" }), { cwd: "/tmp" }),
    ];
    await bothStarted.promise;
    expect(maxActive).toBe(2);
    release.resolve();
    await Promise.all(calls);
  });

  it("holds the key through lifecycle bookkeeping", async () => {
    const afterRunStarted = deferred();
    const releaseAfterRun = deferred();
    const checks: string[] = [];
    const starts: string[] = [];
    const handler = keyedHandler(async (raw) => {
      const { label } = raw as { label: string };
      starts.push(label);
      return { output: label };
    });
    const dispatch = createDispatcher({
      registry: new ToolRegistry().register(handler),
      invariants: {
        async preCheck(use) {
          checks.push((use.input as { label: string }).label);
          return { ok: true };
        },
        async postCommit() {},
      } satisfies InvariantsCheck,
      lifecycle: {
        async afterRun(use) {
          if ((use.input as { label: string }).label === "first") {
            afterRunStarted.resolve();
            await releaseAfterRun.promise;
          }
        },
      },
    });

    const first = dispatch(use("u1", "keyed", { key: "same", label: "first" }), {
      cwd: "/tmp",
    });
    await afterRunStarted.promise;
    const second = dispatch(use("u2", "keyed", { key: "same", label: "second" }), {
      cwd: "/tmp",
    });
    await flushTasks();

    expect(checks).toEqual(["first"]);
    expect(starts).toEqual(["first"]);
    releaseAfterRun.resolve();
    await Promise.all([first, second]);
    expect(checks).toEqual(["first", "second"]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("releases the key when a handler throws", async () => {
    const starts: string[] = [];
    const handler = keyedHandler(async (raw) => {
      const { label } = raw as { label: string };
      starts.push(label);
      if (label === "first") throw new Error("boom");
      return { output: label };
    });
    const dispatch = createDispatcher({ registry: new ToolRegistry().register(handler) });

    const [first, second] = await Promise.all([
      dispatch(use("u1", "keyed", { key: "same", label: "first" }), { cwd: "/tmp" }),
      dispatch(use("u2", "keyed", { key: "same", label: "second" }), { cwd: "/tmp" }),
    ]);

    expect(first.is_error).toBe(true);
    expect(second.is_error).toBeUndefined();
    expect(starts).toEqual(["first", "second"]);
  });

  it("aborts a queued call whose signal fires while waiting, without poisoning the queue", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const starts: string[] = [];
    const handler = keyedHandler(async (raw) => {
      const { label } = raw as { label: string };
      starts.push(label);
      if (label === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { output: label };
    });
    const dispatch = createDispatcher({ registry: new ToolRegistry().register(handler) });

    const first = dispatch(use("u1", "keyed", { key: "same", label: "first" }), { cwd: "/tmp" });
    await firstStarted.promise;
    // The second call queues behind the first; its signal fires mid-queue.
    const ac = new AbortController();
    const second = dispatch(use("u2", "keyed", { key: "same", label: "second" }), {
      cwd: "/tmp",
      signal: ac.signal,
    });
    await flushTasks(); // second is now parked on `await previous`
    ac.abort();
    releaseFirst.resolve();

    const [firstRes, secondRes] = await Promise.all([first, second]);
    // The first ran normally; the queued one surfaced the abort as an error
    // result without ever entering `run`.
    expect(firstRes.is_error).toBeUndefined();
    expect(secondRes.is_error).toBe(true);
    expect(starts).toEqual(["first"]);

    // The queue was not poisoned: a later same-key call still executes.
    const third = dispatch(use("u3", "keyed", { key: "same", label: "third" }), { cwd: "/tmp" });
    expect((await third).content).toBe("third");
    expect(starts).toEqual(["first", "third"]);
  });
});

describe("dispatcher · file serialization", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "nova-dispatch-serialization-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves disjoint concurrent edits even when invariants are disabled", async () => {
    const path = join(dir, "same.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const dispatch = createDispatcher({
      registry: new ToolRegistry().register(editTool),
    });

    const [first, second] = await Promise.all([
      dispatch(use("u1", "edit", { filePath: path, old_string: "alpha", new_string: "ALPHA" }), {
        cwd: dir,
      }),
      dispatch(use("u2", "edit", { path, old_string: "beta", new_string: "BETA" }), {
        cwd: dir,
      }),
    ]);

    expect(first.is_error).toBeUndefined();
    expect(second.is_error).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("ALPHA\nBETA\n");
  });

  it("uses one key for symlink and real-path aliases", async () => {
    const realDir = join(dir, "real");
    await mkdir(realDir);
    await writeFile(join(realDir, "file.txt"), "value", "utf8");
    await symlink(realDir, join(dir, "alias"));

    const realKey = await fileExecutionKey({ path: "real/file.txt" }, { cwd: dir });
    const aliasKey = await fileExecutionKey({ path: "alias/file.txt" }, { cwd: dir });

    expect(aliasKey).toBe(realKey);
  });

  it("assigns read, edit, and write the same canonical file key", async () => {
    const path = join(dir, "shared.txt");
    await writeFile(path, "value", "utf8");
    const ctx = { cwd: dir };

    const keys = await Promise.all([
      readTool.executionKey?.({ path }, ctx),
      editTool.executionKey?.({ path }, ctx),
      writeTool.executionKey?.({ path }, ctx),
    ]);

    expect(keys[0]).toBeDefined();
    expect(new Set(keys).size).toBe(1);
  });
});
