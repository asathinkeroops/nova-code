import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageParam } from "@nova/core";
import { createSession, readSessionWorkspace } from "@nova/base";
import { buildSessionRows, resolveSession } from "./session.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-sessionrows-"));
});

const create = (workspace = "/repo/default") => createSession({ workspace, rootOverride: root });

const writeMsgs = (path: string, msgs: MessageParam[]): Promise<void> =>
  writeFile(path, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");

const userMsg = (text: string): MessageParam => ({ role: "user", content: text });

// Legacy sessions created before session.json use their first session_start as
// the immutable workspace binding.
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
    const s = await create();
    await writeMsgs(s.messagesPath, [userMsg("hello world")]);
    const rows = await buildSessionRows(root, "/repo/default");
    const row = rows.find((r) => r.session.id === s.id);
    expect(row?.label).toBe("hello world");
  });

  it("skips sessions whose history is empty", async () => {
    const empty = await create();
    await new Promise((r) => setTimeout(r, 5));
    const full = await create();
    await writeMsgs(full.messagesPath, [userMsg("do a thing")]);
    const rows = await buildSessionRows(root, "/repo/default");
    const ids = rows.map((r) => r.session.id);
    expect(ids).toContain(full.id);
    expect(ids).not.toContain(empty.id);
  });

  it("keeps a session with unreadable history under a load-failed label", async () => {
    const s = await create();
    await writeFile(s.messagesPath, "{ not valid json\n");
    const rows = await buildSessionRows(root, "/repo/default");
    const row = rows.find((r) => r.session.id === s.id);
    expect(row?.label).toContain("load failed");
  });

  it("lists only sessions bound to the current workspace", async () => {
    const a = await create("/repo/a");
    const b = await create("/repo/b");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await writeMsgs(b.messagesPath, [userMsg("work in b")]);

    const rows = await buildSessionRows(root, "/repo/a");
    expect(rows.map((row) => row.session.id)).toEqual([a.id]);
  });

  it("uses the first session_start as the binding for a legacy session", async () => {
    const legacy = await create("/placeholder");
    await rm(legacy.metadataPath);
    await writeSessionStart(legacy.transcriptPath, "/repo/legacy");
    await writeMsgs(legacy.messagesPath, [userMsg("legacy history")]);

    const rows = await buildSessionRows(root, "/repo/legacy");
    expect(rows.map((row) => row.session.id)).toEqual([legacy.id]);
  });
});

describe("resolveSession --continue", () => {
  it("resumes the newest session for the current workspace, not the newest overall", async () => {
    const a = await create("/repo/a");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await new Promise((r) => setTimeout(r, 10));
    const b = await create("/repo/b");
    await writeMsgs(b.messagesPath, [userMsg("work in b")]);

    // Globally the most recently used session is b, but `--continue` for
    // /repo/a must undo that and pick the newest session that belongs to a.
    const resumedA = await resolveSession({ continue: true }, root, "/repo/a");
    expect(resumedA.session.id).toBe(a.id);
    expect(resumedA.resumed).toBe(true);

    const resumedB = await resolveSession({ continue: true }, root, "/repo/b");
    expect(resumedB.session.id).toBe(b.id);
  });

  it("throws when no bound session belongs to the current workspace", async () => {
    const a = await create("/repo/a");
    await writeMsgs(a.messagesPath, [userMsg("work in a")]);
    await expect(resolveSession({ continue: true }, root, "/repo/none")).rejects.toThrow(
      /no sessions to continue/,
    );
  });

  it("skips a newer empty session instead of pinning continue to it", async () => {
    const resumable = await create("/repo/a");
    await writeMsgs(resumable.messagesPath, [userMsg("keep this history")]);
    await new Promise((r) => setTimeout(r, 10));
    await create("/repo/a");

    const resumed = await resolveSession({ continue: true }, root, "/repo/a");
    expect(resumed.session.id).toBe(resumable.id);
  });

  it("throws when the workspace has only empty sessions", async () => {
    await create("/repo/a");

    await expect(resolveSession({ continue: true }, root, "/repo/a")).rejects.toThrow(
      /no sessions to continue/,
    );
  });

  it("does not let later transcript cwd values rebind a metadata-backed session", async () => {
    const a = await create("/repo/a");
    await writeSessionStart(a.transcriptPath, "/repo/b");
    await writeMsgs(a.messagesPath, [userMsg("owned by a")]);

    const resumed = await resolveSession({ continue: true }, root, "/repo/a");
    expect(resumed.session.id).toBe(a.id);
    await expect(resolveSession({ continue: true }, root, "/repo/b")).rejects.toThrow(
      /no sessions to continue/,
    );
  });
});

describe("resolveSession --resume", () => {
  it("resumes a session bound to the current workspace", async () => {
    const a = await create("/repo/a");
    const resumed = await resolveSession({ resume: a.id }, root, "/repo/a");
    expect(resumed.session.id).toBe(a.id);
    expect(resumed.session.dir).toBe(a.dir);
    expect(resumed.resumed).toBe(true);
  });

  it("rejects a session bound to another workspace with a useful prompt", async () => {
    const a = await create("/repo/a");
    await expect(resolveSession({ resume: a.id }, root, "/repo/b")).rejects.toThrow(
      /belongs to workspace \/repo\/a, not the current workspace \/repo\/b/,
    );
  });

  it("rejects a legacy session whose workspace cannot be determined", async () => {
    const unknown = await create("/placeholder");
    await rm(unknown.metadataPath);
    await expect(resolveSession({ resume: unknown.id }, root, "/repo/a")).rejects.toThrow(
      /has no workspace binding/,
    );
  });
});

describe("resolveSession fresh", () => {
  it("binds a new session to the current workspace", async () => {
    const fresh = await resolveSession({}, root, "/repo/a");
    expect(fresh.resumed).toBe(false);
    expect(await readSessionWorkspace(fresh.session)).toBe("/repo/a");
  });
});
