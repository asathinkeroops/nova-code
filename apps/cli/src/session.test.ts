import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageParam } from "@nova/core";
import { createSession } from "@nova/runtime";
import { buildSessionRows } from "./session.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-sessionrows-"));
});

const writeMsgs = (path: string, msgs: MessageParam[]): Promise<void> =>
  writeFile(path, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");

const userMsg = (text: string): MessageParam => ({ role: "user", content: text });

describe("buildSessionRows", () => {
  it("labels a session with its first user message", async () => {
    const s = await createSession(root);
    await writeMsgs(s.messagesPath, [userMsg("hello world")]);
    const rows = await buildSessionRows(root);
    const row = rows.find((r) => r.session.id === s.id);
    expect(row?.label).toBe("hello world");
  });

  it("skips sessions whose history is empty", async () => {
    const empty = await createSession(root);
    await new Promise((r) => setTimeout(r, 5));
    const full = await createSession(root);
    await writeMsgs(full.messagesPath, [userMsg("do a thing")]);
    const rows = await buildSessionRows(root);
    const ids = rows.map((r) => r.session.id);
    expect(ids).toContain(full.id);
    expect(ids).not.toContain(empty.id);
  });

  it("keeps a session with unreadable history under a load-failed label", async () => {
    const s = await createSession(root);
    await writeFile(s.messagesPath, "{ not valid json\n");
    const rows = await buildSessionRows(root);
    const row = rows.find((r) => r.session.id === s.id);
    expect(row?.label).toContain("load failed");
  });
});
