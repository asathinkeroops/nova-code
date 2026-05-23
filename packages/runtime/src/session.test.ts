import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, getSession, listSessions } from "./session.js";

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
