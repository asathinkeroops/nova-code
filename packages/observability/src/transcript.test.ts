import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Transcript } from "./transcript.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nova-transcript-"));
});

describe("Transcript", () => {
  it("appends JSONL records and reads them back in order", async () => {
    const t = new Transcript(join(dir, "transcript.jsonl"));
    await t.append({ kind: "session_start", data: { id: "abc" } });
    await t.append({ kind: "user_prompt", data: { text: "hi" } });
    await t.append({ kind: "assistant", turn: 1, data: { blocks: [] } });
    await t.flush();
    const records = await t.readAll();
    expect(records.map((r) => r.kind)).toEqual(["session_start", "user_prompt", "assistant"]);
    expect(records[2]?.turn).toBe(1);
    expect(records.every((r) => typeof r.timestamp === "string")).toBe(true);
  });

  it("preserves write order under concurrent appends", async () => {
    const t = new Transcript(join(dir, "concurrent.jsonl"));
    const writes = Array.from({ length: 20 }, (_, i) =>
      t.append({ kind: "assistant", turn: i, data: { i } }),
    );
    await Promise.all(writes);
    const records = await t.readAll();
    expect(records.map((r) => (r.data as { i: number }).i)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  it("returns empty list for missing transcript", async () => {
    const t = new Transcript(join(dir, "missing.jsonl"));
    expect(await t.readAll()).toEqual([]);
  });
});
