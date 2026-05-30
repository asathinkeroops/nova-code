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

export interface RestorePlan {
  /** Files to roll back to prior content. */
  toModify: { path: string; blob: string }[];
  /** Files to delete (they were created at/after the target turn). */
  toRemove: string[];
  /** Records with epoch >= this are consumed by the restore. */
  fromEpoch: number;
}

function keyOf(epoch: number, path: string): string {
  return `${epoch}\0${path}`;
}

/**
 * Per-session, write-ahead file snapshotter backing `/rewind`'s file
 * restoration. Before a write/edit tool first mutates a path within a user
 * turn, `capture` stashes the prior content (deduped by content hash). On
 * rewind, `plan` + `restore` roll every path that changed at/after the target
 * turn back to its pre-turn state.
 *
 * Storage layout under `dir`:
 *   index.jsonl      — one SnapshotRecord per line (append-only log)
 *   blobs/<sha256>   — prior file contents, content-addressed
 *
 * Only the `write` and `edit` tools are captured; side effects from `bash`
 * (rm, sed -i, redirects) are invisible to this store. Sub-agent file writes
 * are likewise not captured — they run their own loop, off the main hooks.
 */
export class SnapshotStore {
  private readonly indexPath: string;
  private readonly blobsDir: string;
  private records: SnapshotRecord[] = [];
  private captured = new Set<string>();
  private epoch = 0;

  constructor(private readonly dir: string) {
    this.indexPath = join(dir, "index.jsonl");
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
      const blob = createHash("sha256").update(content).digest("hex");
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
   * Build the restore plan for rewinding to `targetEpoch`. For each path
   * touched at/after the target, the earliest (smallest-epoch) record holds
   * its pre-target state, so that's the one we roll back to.
   */
  plan(targetEpoch: number): RestorePlan {
    const earliest = new Map<string, SnapshotRecord>();
    for (const rec of this.records) {
      if (rec.epoch < targetEpoch) continue;
      const prev = earliest.get(rec.path);
      if (!prev || rec.epoch < prev.epoch) earliest.set(rec.path, rec);
    }
    const toModify: { path: string; blob: string }[] = [];
    const toRemove: string[] = [];
    for (const rec of earliest.values()) {
      if (rec.kind === "modify" && rec.blob) toModify.push({ path: rec.path, blob: rec.blob });
      else toRemove.push(rec.path);
    }
    return { toModify, toRemove, fromEpoch: targetEpoch };
  }

  /** Execute a plan, then drop the consumed records from the log. */
  async restore(plan: RestorePlan): Promise<void> {
    for (const { path, blob } of plan.toModify) {
      const content = await readFile(join(this.blobsDir, blob));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    for (const path of plan.toRemove) {
      await rm(path, { force: true });
    }
    await this.prune(plan.fromEpoch);
  }

  /** Rebuild in-memory state from index.jsonl (used after /resume). */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    this.records = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as SnapshotRecord);
    this.captured = new Set(this.records.map((r) => keyOf(r.epoch, r.path)));
  }

  private async prune(fromEpoch: number): Promise<void> {
    this.records = this.records.filter((r) => r.epoch < fromEpoch);
    this.captured = new Set(this.records.map((r) => keyOf(r.epoch, r.path)));
    const body =
      this.records.length === 0
        ? ""
        : this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.indexPath);
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
}
