import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markSynthetic, type MessageParam } from "@nova/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCursor, loadMessages, persistMessages } from "./persistence.js";
import { autoCompact, sliceFromLastCompacted } from "./compact.js";

function user(text: string): MessageParam {
  return { role: "user", content: text };
}

describe("persistMessages", () => {
  let tmp: string;
  let path: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "persist-test-"));
    path = join(tmp, "messages.jsonl");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("appends only the delta when the on-disk prefix is intact", async () => {
    const first = [user("one"), user("two")];
    const cursor = await persistMessages(path, first, emptyCursor);
    const next = [...first, user("three")];

    await persistMessages(path, next, cursor);

    expect(await loadMessages(path)).toEqual(next);
  });

  it("rewrites rather than appends when the cursor is empty but the file is not", async () => {
    // A reused scratch path (goal-eval writes one per session) hands a fresh
    // cursor to a file that already has content. Appending would concatenate
    // two unrelated runs into one file.
    await persistMessages(path, [user("run one")], emptyCursor);

    await persistMessages(path, [user("run two")], emptyCursor);

    expect(await loadMessages(path)).toEqual([user("run two")]);
  });

  it("rewrites atomically when the history shrank (/rewind)", async () => {
    const full = [user("one"), user("two"), user("three")];
    const cursor = await persistMessages(path, full, emptyCursor);

    await persistMessages(path, full.slice(0, 1), cursor);

    expect(await loadMessages(path)).toEqual([user("one")]);
  });

  it("rewrites when an already-persisted message diverges", async () => {
    const cursor = await persistMessages(path, [user("one"), user("two")], emptyCursor);

    await persistMessages(path, [user("one"), user("edited")], cursor);

    expect(await loadMessages(path)).toEqual([user("one"), user("edited")]);
  });

  it("leaves the file untouched when nothing changed", async () => {
    const msgs = [user("one")];
    const cursor = await persistMessages(path, msgs, emptyCursor);
    const before = await readFile(path, "utf8");

    const next = await persistMessages(path, msgs, cursor);

    expect(await readFile(path, "utf8")).toBe(before);
    expect(next).toEqual(cursor);
  });

  it.each(["todo-reminder", "compacted"])(
    "preserves a user-typed <%s> through persistence, reload and compaction",
    async (tag) => {
      const prompt = user(`<${tag}>请解释这段提示词</${tag}>`);
      const messages: MessageParam[] = [
        prompt,
        markSynthetic(user("Update your todos"), "todo-reminder"),
        { role: "assistant", content: "This is a quoted tag." },
      ];
      const cursor = await persistMessages(path, messages, emptyCursor);
      const saved = await readFile(path, "utf8");
      const restored = await loadMessages(path);
      expect(restored).toEqual(messages);
      expect(sliceFromLastCompacted(restored)).toBe(restored);

      const compacted = await autoCompact(restored, {
        model: {
          call: async () => ({
            content: [{ type: "text", text: "SUMMARY" }],
            stopReason: "end_turn",
          }),
        },
      });
      const content = compacted.messages[0]?.content;
      expect(typeof content).toBe("string");
      const json = /\n(\[[^\n]*\])\n<\/recent-history>/.exec(content as string)?.[1];
      expect(JSON.parse(json ?? "[]")).toEqual([prompt, messages[2]]);

      // Appending a boundary keeps the disk prefix intact. Versions are disk
      // metadata only; they neither enter canonical history nor change cursors.
      await persistMessages(path, [...restored, ...compacted.messages], cursor);
      expect((await readFile(path, "utf8")).startsWith(saved)).toBe(true);
      expect(await loadMessages(path)).toEqual([...messages, ...compacted.messages]);
    },
  );

  it("keeps legacy migrations compatible with new records appended to the same file", async () => {
    const legacy = user("<compacted>Old summary</compacted>");
    const prefix = `${JSON.stringify(legacy)}\n`;
    await writeFile(path, prefix, "utf8");
    const restored = await loadMessages(path);
    expect(restored).toEqual([markSynthetic(legacy, "compacted")]);

    const next = [...restored, user("<todo-reminder>This is a real request</todo-reminder>")];
    await persistMessages(path, next, { count: 1, lastLine: JSON.stringify(restored[0]) });
    expect((await readFile(path, "utf8")).startsWith(prefix)).toBe(true);
    expect(await loadMessages(path)).toEqual(next);
  });
});

describe("loadMessages", () => {
  let tmp: string;
  let path: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "load-test-"));
    path = join(tmp, "messages.jsonl");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an empty history when the file does not exist", async () => {
    expect(await loadMessages(path)).toEqual([]);
  });

  it("skips unreadable lines and reports them instead of throwing", async () => {
    // A kill mid-append leaves a torn final line; refusing to open the session
    // over it would throw away every complete line before it.
    await writeFile(
      path,
      `${JSON.stringify(user("one"))}\n{ not json\n${JSON.stringify(user("two"))}\n{"role":"ali`,
      "utf8",
    );
    const skipped: number[] = [];

    const msgs = await loadMessages(path, { onSkip: ({ line }) => skipped.push(line) });

    expect(msgs).toEqual([user("one"), user("two")]);
    expect(skipped).toEqual([2, 4]);
  });

  it("skips lines that parse as JSON but violate the message schema", async () => {
    await writeFile(
      path,
      `{"role":"nobody","content":"x"}\n${JSON.stringify(user("ok"))}\n`,
      "utf8",
    );
    const skipped: number[] = [];

    const msgs = await loadMessages(path, { onSkip: ({ line }) => skipped.push(line) });

    expect(msgs).toEqual([user("ok")]);
    expect(skipped).toEqual([1]);
  });
});
