import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageParam } from "@nova/core";
import { createSession } from "@nova/base";
import { buildSessionRows, resolveSession } from "./session.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-sessionrows-"));
});

const writeMsgs = (path: string, msgs: MessageParam[]): Promise<void> =>
  writeFile(path, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");

const userMsg = (text: string): MessageParam => ({ role: "user", content: text });

// Writes the transcript's first `session_start` record, which is what
// resolveSession uses to attribute a session to a workspace.
const writeSessionStart = (path: string, cwd: string): Promise<void> =>
  writeFile(
    path,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      kind: "session_start",
      data: { id: "x", cwd, model: "pro", resumed: false },
    })}\n`,
  );

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

describe("resolveSession --continue", () => {
  it("resumes the newest session for the current workspace, not the newest overall", async () => {
    const a = await createSession(root);
    await writeSessionStart(a.transcriptPath, "/repo/a");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await new Promise((r) => setTimeout(r, 10));
    const b = await createSession(root);
    await writeSessionStart(b.transcriptPath, "/repo/b");
    await writeMsgs(b.messagesPath, [userMsg("work in b")]);

    // Globally the most recently used session is b, but `--continue` for
    // /repo/a must undo that and pick the newest session that belongs to a.
    const resumedA = await resolveSession({ continue: true }, root, "/repo/a");
    expect(resumedA.session.id).toBe(a.id);
    expect(resumedA.resumed).toBe(true);

    const resumedB = await resolveSession({ continue: true }, root, "/repo/b");
    expect(resumedB.session.id).toBe(b.id);
  });

  it("throws when no recorded session belongs to the current workspace", async () => {
    const a = await createSession(root);
    await writeSessionStart(a.transcriptPath, "/repo/a");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await expect(resolveSession({ continue: true }, root, "/repo/none")).rejects.toThrow(
      /no sessions to continue/,
    );
  });

  it("skips a newer empty session instead of pinning continue to it", async () => {
    const resumable = await createSession(root);
    await writeSessionStart(resumable.transcriptPath, "/repo/a");
    await writeMsgs(resumable.messagesPath, [userMsg("keep this history")]);
    await new Promise((r) => setTimeout(r, 10));
    const empty = await createSession(root);
    await writeSessionStart(empty.transcriptPath, "/repo/a");

    const resumed = await resolveSession({ continue: true }, root, "/repo/a");
    expect(resumed.session.id).toBe(resumable.id);
  });

  it("throws when the workspace has only empty sessions", async () => {
    const empty = await createSession(root);
    await writeSessionStart(empty.transcriptPath, "/repo/a");

    await expect(resolveSession({ continue: true }, root, "/repo/a")).rejects.toThrow(
      /no sessions to continue/,
    );
  });

  it("still resumes the most recent session overall when no workspace is known", async () => {
    const a = await createSession(root);
    await writeSessionStart(a.transcriptPath, "/repo/a");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await new Promise((r) => setTimeout(r, 10));
    const b = await createSession(root);
    await writeSessionStart(b.transcriptPath, "/repo/b");
    await writeMsgs(b.messagesPath, [userMsg("work in b")]);

    const resumed = await resolveSession({ continue: true }, root);
    expect(resumed.session.id).toBe(b.id);
  });
});
