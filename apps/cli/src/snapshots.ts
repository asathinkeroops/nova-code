import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * One captured file state. `epoch` is the message-array length at the start of
 * the user turn that first touched this path (see SnapshotStore.setEpoch), so
 * it lines up exactly with the index `/rewind` truncates the history to.
 *
 *  - kind "modify": the file existed before the turn; `blob` is the sha256 of
 *    its prior content (stored under blobs/).
 *  - kind "create": the file did not exist; restoring means deleting it.
 */
export interface SnapshotRecord {
  epoch: number;
  /** Absolute path. */
  path: string;
  kind: "modify" | "create";
  /** sha256 of the prior content for "modify"; null for "create". */
  blob: string | null;
}

/** One `results.jsonl` line: the sha256 nova last wrote to `path` (last wins). */
interface ResultRecord {
  path: string;
  /** sha256 of the content nova's last write/edit left on disk. */
  hash: string;
}

export interface RestorePlan {
  /** Files to roll back to prior content (current disk == nova's last write). */
  toModify: { path: string; blob: string }[];
  /** Files to delete (created at/after target, still holding nova's version). */
  toRemove: string[];
  /**
   * Files touched at/after the target whose on-disk content has diverged from
   * what nova last wrote — changed by `bash`, a sub-agent, another session, git,
   * or by hand. Restoring would clobber that newer content, so they are skipped
   * and surfaced instead. `kind` mirrors the underlying snapshot record.
   */
  conflicts: { path: string; kind: "modify" | "create" }[];
  /** Records with epoch >= this are consumed by the restore. */
  fromEpoch: number;
}

function keyOf(epoch: number, path: string): string {
  return `${epoch}\0${path}`;
}

function hashOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Per-session, write-ahead file snapshotter backing `/rewind`'s file
 * restoration. Before a write/edit tool first mutates a path within a user
 * turn, `capture` stashes the prior content (deduped by content hash). After
 * each write/edit, `recordResult` remembers the hash it left on disk. On
 * rewind, `plan` + `restore` roll every path that changed at/after the target
 * turn back to its pre-turn state — but only where the current on-disk content
 * still matches nova's last write. A path that drifted away from that (external
 * edit, `bash`, sub-agent, another session, git) is reported as a conflict and
 * left untouched, so rewind never silently overwrites work nova didn't make.
 *
 * Storage layout under `dir`:
 *   index.jsonl      — one SnapshotRecord per line (append-only log)
 *   results.jsonl    — one ResultRecord per line, last-wins (append-only log)
 *   blobs/<sha256>   — prior file contents, content-addressed
 *
 * Only the `write` and `edit` tools are captured; side effects from `bash`
 * (rm, sed -i, redirects) are invisible to this store. Sub-agent file writes
 * are likewise not captured — they run their own loop, off the main hooks.
 * Both of those show up as conflicts at rewind time rather than being reverted.
 */
export class SnapshotStore {
  private readonly indexPath: string;
  private readonly resultsPath: string;
  private readonly blobsDir: string;
  private records: SnapshotRecord[] = [];
  /** path → sha256 of the content nova's last write/edit left on disk. */
  private latest = new Map<string, string>();
  private captured = new Set<string>();
  private epoch = 0;

  constructor(private readonly dir: string) {
    this.indexPath = join(dir, "index.jsonl");
    this.resultsPath = join(dir, "results.jsonl");
    this.blobsDir = join(dir, "blobs");
  }

  /** Mark the start of a user turn; subsequent captures tag this epoch. */
  setEpoch(epoch: number): void {
    this.epoch = epoch;
  }

  /**
   * Capture `absPath`'s current on-disk content as the pre-turn baseline, once
   * per (epoch, path). A missing file is recorded as a "create" so rewind can
   * delete it. Best-effort: failures are swallowed so a snapshot hiccup never
   * blocks a tool call.
   */
  async capture(absPath: string): Promise<void> {
    const key = keyOf(this.epoch, absPath);
    if (this.captured.has(key)) return;
    this.captured.add(key);

    let rec: SnapshotRecord;
    try {
      const content = await readFile(absPath);
      const blob = hashOf(content);
      await this.writeBlob(blob, content);
      rec = { epoch: this.epoch, path: absPath, kind: "modify", blob };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        rec = { epoch: this.epoch, path: absPath, kind: "create", blob: null };
      } else {
        // Unreadable for some other reason — drop the dedupe mark so a later
        // attempt can retry, and skip recording.
        this.captured.delete(key);
        return;
      }
    }
    this.records.push(rec);
    await this.appendIndex(rec);
  }

  /**
   * Remember what `absPath` looks like right after nova's write/edit completed,
   * so a later `plan` can tell "still nova's version" from "changed underneath
   * us." Call after the tool runs. Best-effort: a read failure just leaves the
   * path unverifiable, which `plan` treats conservatively (as a conflict).
   */
  async recordResult(absPath: string): Promise<void> {
    let hash: string;
    try {
      hash = hashOf(await readFile(absPath));
    } catch {
      return; // e.g. the write actually deleted it — nothing to verify against
    }
    if (this.latest.get(absPath) === hash) return;
    this.latest.set(absPath, hash);
    await this.appendResult({ path: absPath, hash });
  }

  /**
   * Build the restore plan for rewinding to `targetEpoch`. For each path
   * touched at/after the target, the earliest (smallest-epoch) record holds
   * its pre-target state, so that's the one we roll back to — unless the file's
   * current content has diverged from nova's last write, in which case it goes
   * to `conflicts` and is left alone. Reads current file contents, so async.
   */
  async plan(targetEpoch: number): Promise<RestorePlan> {
    const earliest = new Map<string, SnapshotRecord>();
    for (const rec of this.records) {
      if (rec.epoch < targetEpoch) continue;
      const prev = earliest.get(rec.path);
      if (!prev || rec.epoch < prev.epoch) earliest.set(rec.path, rec);
    }
    const toModify: { path: string; blob: string }[] = [];
    const toRemove: string[] = [];
    const conflicts: { path: string; kind: "modify" | "create" }[] = [];
    for (const rec of earliest.values()) {
      if (await this.diverged(rec.path)) {
        conflicts.push({ path: rec.path, kind: rec.kind });
      } else if (rec.kind === "modify" && rec.blob) {
        toModify.push({ path: rec.path, blob: rec.blob });
      } else {
        toRemove.push(rec.path);
      }
    }
    return { toModify, toRemove, conflicts, fromEpoch: targetEpoch };
  }

  /**
   * True if `absPath`'s current on-disk content is NOT the one nova last wrote
   * — i.e. rolling it back would destroy changes nova didn't make. A path we
   * never recorded a result for (older session, or only touched by untracked
   * means) is unverifiable, so it counts as diverged: better to surface it than
   * to clobber. A path nova deleted after writing (gone now) is not treated as
   * diverged — restoring its prior content is the point of rewind.
   */
  private async diverged(absPath: string): Promise<boolean> {
    const expected = this.latest.get(absPath);
    if (expected === undefined) return true;
    let current: string;
    try {
      current = hashOf(await readFile(absPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true; // unreadable for another reason — don't risk overwriting
    }
    return current !== expected;
  }

  /** Execute a plan, then drop the consumed records from the log. */
  async restore(plan: RestorePlan): Promise<void> {
    for (const { path, blob } of plan.toModify) {
      const content = await readFile(join(this.blobsDir, blob));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      // The file now holds the prior blob's bytes — keep `latest` truthful so a
      // subsequent rewind through the same path verifies against reality.
      this.latest.set(path, blob);
    }
    for (const path of plan.toRemove) {
      await rm(path, { force: true });
      this.latest.delete(path);
    }
    await this.prune(plan.fromEpoch);
  }

  /** Rebuild in-memory state from index.jsonl + results.jsonl (after /resume). */
  async load(): Promise<void> {
    const index = await this.readLog(this.indexPath);
    this.records = index.map((l) => JSON.parse(l) as SnapshotRecord);
    this.captured = new Set(this.records.map((r) => keyOf(r.epoch, r.path)));

    const results = await this.readLog(this.resultsPath);
    this.latest = new Map();
    for (const line of results) {
      const rec = JSON.parse(line) as ResultRecord;
      this.latest.set(rec.path, rec.hash); // last line wins
    }
  }

  private async readLog(path: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw.split("\n").filter((l) => l.length > 0);
  }

  private async prune(fromEpoch: number): Promise<void> {
    this.records = this.records.filter((r) => r.epoch < fromEpoch);
    this.captured = new Set(this.records.map((r) => keyOf(r.epoch, r.path)));
    await this.rewriteLog(
      this.indexPath,
      this.records.map((r) => JSON.stringify(r)),
    );
    // Compact results.jsonl back to one line per surviving path so it can't
    // grow without bound across many turns.
    await this.rewriteLog(
      this.resultsPath,
      [...this.latest].map(([path, hash]) => JSON.stringify({ path, hash })),
    );
  }

  private async rewriteLog(path: string, lines: string[]): Promise<void> {
    const body = lines.length === 0 ? "" : lines.join("\n") + "\n";
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  }

  private async writeBlob(blob: string, content: Buffer): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    const path = join(this.blobsDir, blob);
    try {
      // Content-addressed: if the blob already exists, its bytes are identical.
      await writeFile(path, content, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    }
  }

  private async appendIndex(rec: SnapshotRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.indexPath, JSON.stringify(rec) + "\n", "utf8");
  }

  private async appendResult(rec: ResultRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.resultsPath, JSON.stringify(rec) + "\n", "utf8");
  }
}
