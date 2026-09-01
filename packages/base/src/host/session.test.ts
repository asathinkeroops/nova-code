import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  getSession,
  listSessions,
  pruneSessions,
  selectExpiredSessions,
  type ExpiringSession,
} from "./session.js";

const DAY = 24 * 60 * 60 * 1000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-session-"));
});

afterEach(() => {
  // session test root is scoped under tmpdir; OS cleans it
});

describe("session", () => {
  it("creates a session directory with a transcript path", async () => {
    const s = await createSession(root);
    expect(s.id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/);
    expect(s.dir.startsWith(root)).toBe(true);
    await writeFile(s.transcriptPath, "hello\n");
    const back = await readFile(s.transcriptPath, "utf8");
    expect(back).toBe("hello\n");
  });

  it("lists sessions newest first", async () => {
    const a = await createSession(root);
    await new Promise((r) => setTimeout(r, 5));
    const b = await createSession(root);
    const list = await listSessions(root);
    const ids = list.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("orders by last activity, not creation, so --continue resumes the last-used session", async () => {
    // `older` is created first, `newer` second — by birthtime `newer` would win.
    const older = await createSession(root);
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createSession(root);

    // But we then work in `older` (append to its history) more recently, so it
    // must sort to the head — that's what `nova -c` reaches for.
    const now = Date.now();
    await writeFile(newer.messagesPath, '{"role":"user","content":"hi"}\n');
    await utimes(newer.messagesPath, new Date(now - 60_000), new Date(now - 60_000));
    await writeFile(older.messagesPath, '{"role":"user","content":"hi"}\n');
    await utimes(older.messagesPath, new Date(now), new Date(now));

    const list = await listSessions(root);
    expect(list[0]?.id).toBe(older.id);
  });

  it("ignores transcript-only activity when ordering resumable sessions", async () => {
    const transcriptOnlyRecent = await createSession(root);
    const messagesRecent = await createSession(root);
    const now = Date.now();

    await writeFile(transcriptOnlyRecent.messagesPath, '{"role":"user","content":"old"}\n');
    await utimes(transcriptOnlyRecent.messagesPath, new Date(now - 60_000), new Date(now - 60_000));
    await writeFile(transcriptOnlyRecent.transcriptPath, "session_start\n");
    await utimes(transcriptOnlyRecent.transcriptPath, new Date(now), new Date(now));

    await writeFile(messagesRecent.messagesPath, '{"role":"user","content":"new"}\n');
    await utimes(messagesRecent.messagesPath, new Date(now - 30_000), new Date(now - 30_000));

    const list = await listSessions(root);
    expect(list[0]?.id).toBe(messagesRecent.id);
  });

  it("returns null for unknown id", async () => {
    const s = await getSession("does-not-exist", root);
    expect(s).toBeNull();
  });

  it("returns session by id", async () => {
    const created = await createSession(root);
    const fetched = await getSession(created.id, root);
    expect(fetched?.id).toBe(created.id);
  });
});

describe("selectExpiredSessions", () => {
  const now = new Date("2026-06-03T00:00:00.000Z");
  const at = (daysAgo: number): Date => new Date(now.getTime() - daysAgo * DAY);
  const s = (id: string, daysAgo: number): ExpiringSession => ({
    id,
    dir: `/tmp/${id}`,
    lastActiveAt: at(daysAgo),
  });

  it("keeps sessions inside the window and drops older ones", () => {
    const expired = selectExpiredSessions([s("fresh", 5), s("old", 40)], now, 30);
    expect(expired.map((e) => e.id)).toEqual(["old"]);
  });

  it("treats exactly maxAgeDays old as still fresh (strict <)", () => {
    // 30 days ago == cutoff; not strictly before it, so it is kept.
    expect(selectExpiredSessions([s("edge", 30)], now, 30)).toEqual([]);
    expect(selectExpiredSessions([s("just-over", 31)], now, 30).map((e) => e.id)).toEqual([
      "just-over",
    ]);
  });

  it("never deletes a protected id even when expired", () => {
    const expired = selectExpiredSessions([s("active", 99), s("old", 40)], now, 30, ["active"]);
    expect(expired.map((e) => e.id)).toEqual(["old"]);
  });

  it("disables pruning for a non-positive or non-finite window", () => {
    const all = [s("old", 999)];
    expect(selectExpiredSessions(all, now, 0)).toEqual([]);
    expect(selectExpiredSessions(all, now, -1)).toEqual([]);
    expect(selectExpiredSessions(all, now, Number.NaN)).toEqual([]);
  });
});

describe("pruneSessions", () => {
  const now = new Date("2026-06-03T00:00:00.000Z");

  // Stamp a session's history mtime to `daysAgo` so age is driven by
  // last-activity (mtime), not the directory's birthtime.
  const ageBy = async (messagesPath: string, daysAgo: number): Promise<void> => {
    const when = new Date(now.getTime() - daysAgo * DAY);
    await writeFile(messagesPath, '{"role":"user","content":"hi"}\n');
    await utimes(messagesPath, when, when);
  };

  const ids = async (): Promise<string[]> => (await readdir(root)).sort();

  it("removes sessions whose last activity is older than maxAgeDays", async () => {
    const fresh = await createSession(root);
    await ageBy(fresh.messagesPath, 5);
    const old = await createSession(root);
    await ageBy(old.messagesPath, 40);

    const res = await pruneSessions({ rootOverride: root, maxAgeDays: 30, now });

    expect(res.removed).toEqual([old.id]);
    expect(res.failed).toBe(0);
    expect(await ids()).toEqual([fresh.id]);
  });

  it("protects the active session even if it looks old", async () => {
    const active = await createSession(root);
    await ageBy(active.messagesPath, 40);

    const res = await pruneSessions({
      rootOverride: root,
      maxAgeDays: 30,
      now,
      protectedIds: [active.id],
    });

    expect(res.removed).toEqual([]);
    expect(await ids()).toEqual([active.id]);
  });

  it("does nothing when every session is within the window", async () => {
    const a = await createSession(root);
    await ageBy(a.messagesPath, 1);
    const b = await createSession(root);
    await ageBy(b.messagesPath, 10);

    const res = await pruneSessions({ rootOverride: root, maxAgeDays: 30, now });

    expect(res.removed).toEqual([]);
    expect((await ids()).length).toBe(2);
  });
});
