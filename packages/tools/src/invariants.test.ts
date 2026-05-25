import { mkdtemp, rm, stat, utimes, writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolUseBlock } from "@nova/core";
import { InMemoryFileAccessLedger, createInvariants } from "./invariants.js";

function use(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: `u_${name}`, name, input };
}

let dir: string;
let ledger: InMemoryFileAccessLedger;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nova-invariants-"));
  ledger = new InMemoryFileAccessLedger();
  ctx = { cwd: dir, fileLedger: ledger };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const baseOpts = { readBeforeEdit: true, mtimeCheck: true };

describe("invariants · read-before-edit", () => {
  it("rejects edit without a prior read", async () => {
    await writeFile(join(dir, "code.ts"), "x = 1");
    const inv = createInvariants(baseOpts);
    const r = await inv.preCheck(
      use("edit", { path: "code.ts", old_string: "x", new_string: "y" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/must be read first/);
  });

  it("allows edit after a recorded read", async () => {
    const path = join(dir, "code.ts");
    await writeFile(path, "x = 1");
    const inv = createInvariants(baseOpts);

    const readUse = use("read", { path: "code.ts" });
    expect(await inv.preCheck(readUse, ctx)).toEqual({ ok: true });
    await inv.postCommit(readUse, ctx, false);

    const r = await inv.preCheck(
      use("edit", { path: "code.ts", old_string: "x", new_string: "y" }),
      ctx,
    );
    expect(r).toEqual({ ok: true });
  });

  it("allows write to a brand-new file with no prior read", async () => {
    const inv = createInvariants(baseOpts);
    const r = await inv.preCheck(
      use("write", { path: "fresh.txt", content: "hi" }),
      ctx,
    );
    expect(r).toEqual({ ok: true });
  });

  it("rejects write that overwrites an existing un-read file", async () => {
    await writeFile(join(dir, "data.json"), "{}");
    const inv = createInvariants(baseOpts);
    const r = await inv.preCheck(
      use("write", { path: "data.json", content: "{}" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/must be read first before overwriting/);
  });

  it("rejects edit on a non-existent file even after a phantom read entry", async () => {
    const inv = createInvariants(baseOpts);
    const r = await inv.preCheck(
      use("edit", { path: "ghost.ts", old_string: "a", new_string: "b" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/does not exist/);
  });

  it("skips read-before-edit when disabled", async () => {
    await writeFile(join(dir, "x.ts"), "a");
    const inv = createInvariants({
      readBeforeEdit: false,
      mtimeCheck: true,
    });
    const r = await inv.preCheck(
      use("edit", { path: "x.ts", old_string: "a", new_string: "b" }),
      ctx,
    );
    expect(r).toEqual({ ok: true });
  });
});

describe("invariants · mtime drift", () => {
  it("rejects edit when the file changed since the recorded read", async () => {
    const path = join(dir, "drift.ts");
    await writeFile(path, "old");
    const inv = createInvariants(baseOpts);

    const readUse = use("read", { path: "drift.ts" });
    await inv.preCheck(readUse, ctx);
    await inv.postCommit(readUse, ctx, false);

    // External writer bumps mtime.
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);

    const r = await inv.preCheck(
      use("edit", { path: "drift.ts", old_string: "old", new_string: "new" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/mtime drift/);
  });

  it("allows consecutive edits because postCommit refreshes the baseline", async () => {
    const path = join(dir, "back2back.ts");
    await writeFile(path, "a");
    const inv = createInvariants(baseOpts);

    const readUse = use("read", { path: "back2back.ts" });
    await inv.preCheck(readUse, ctx);
    await inv.postCommit(readUse, ctx, false);

    // Simulate the first edit completing: tool rewrites the file and bumps
    // mtime, then dispatcher calls postCommit which must re-baseline.
    await writeFile(path, "b");
    const future = new Date(Date.now() + 2000);
    await utimes(path, future, future);
    const editUse1 = use("edit", { path: "back2back.ts", old_string: "a", new_string: "b" });
    await inv.postCommit(editUse1, ctx, false);

    // Second edit should still pass — baseline got refreshed.
    const r = await inv.preCheck(
      use("edit", { path: "back2back.ts", old_string: "b", new_string: "c" }),
      ctx,
    );
    expect(r).toEqual({ ok: true });
  });

  it("rejects edit when the file was deleted after read", async () => {
    const path = join(dir, "gone.ts");
    await writeFile(path, "x");
    const inv = createInvariants(baseOpts);
    const readUse = use("read", { path: "gone.ts" });
    await inv.preCheck(readUse, ctx);
    await inv.postCommit(readUse, ctx, false);
    await unlink(path);

    const r = await inv.preCheck(
      use("edit", { path: "gone.ts", old_string: "x", new_string: "y" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/does not exist/);
  });

  it("skips mtime check when disabled", async () => {
    const path = join(dir, "lax.ts");
    await writeFile(path, "old");
    const inv = createInvariants({
      readBeforeEdit: true,
      mtimeCheck: false,
    });

    const readUse = use("read", { path: "lax.ts" });
    await inv.preCheck(readUse, ctx);
    await inv.postCommit(readUse, ctx, false);

    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);

    const r = await inv.preCheck(
      use("edit", { path: "lax.ts", old_string: "old", new_string: "new" }),
      ctx,
    );
    expect(r).toEqual({ ok: true });
  });
});

describe("invariants · postCommit error suppression", () => {
  it("does not record reads that errored", async () => {
    const inv = createInvariants(baseOpts);
    const readUse = use("read", { path: "nowhere.ts" });
    await inv.postCommit(readUse, ctx, true);
    expect(ledger.get(join(dir, "nowhere.ts"))).toBeUndefined();
  });
});

describe("invariants · gating scope", () => {
  it("ignores unrelated tools (grep, glob, bash, ...)", async () => {
    const inv = createInvariants(baseOpts);
    expect(
      await inv.preCheck(use("grep", { pattern: "foo", path: "/etc" }), ctx),
    ).toEqual({ ok: true });
    expect(
      await inv.preCheck(use("bash", { command: "echo hi" }), ctx),
    ).toEqual({ ok: true });
  });
});

describe("invariants · nested directory access", () => {
  it("allows reads under a nested allowed subdir", async () => {
    await mkdir(join(dir, "sub", "deep"), { recursive: true });
    await writeFile(join(dir, "sub", "deep", "f.ts"), "k");
    const inv = createInvariants(baseOpts);
    const r = await inv.preCheck(use("read", { path: "sub/deep/f.ts" }), ctx);
    expect(r).toEqual({ ok: true });
  });
});

describe("invariants · dispatcher integration sanity", () => {
  it("ledger.get returns mtime after a recorded read", async () => {
    const path = join(dir, "stamped.ts");
    await writeFile(path, "v");
    const inv = createInvariants(baseOpts);
    const readUse = use("read", { path: "stamped.ts" });
    await inv.preCheck(readUse, ctx);
    await inv.postCommit(readUse, ctx, false);
    const expected = (await stat(path)).mtimeMs;
    expect(ledger.get(path)?.lastReadMtimeMs).toBe(expected);
  });
});
