import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  description: string;
  blockedBy: string[];
  status: TaskStatus;
}

export interface TaskUpdatePatch {
  status?: TaskStatus;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["in_progress", "completed"],
  in_progress: ["completed", "pending"],
  completed: ["pending"],
};

function generateId(): string {
  return randomBytes(6).toString("base64url");
}

function cloneTask(t: Task): Task {
  return { ...t, blockedBy: [...t.blockedBy] };
}

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export class TaskStore {
  private readonly tasksDir: string;
  private readonly tasks = new Map<string, Task>();
  private loadPromise: Promise<void> | null = null;

  constructor(workspaceDir: string, sessionId: string) {
    this.tasksDir = path.join(workspaceDir, ".tasks", sessionId);
  }

  async create(description: string): Promise<Task> {
    await this.ensureLoaded();
    const trimmed = description.trim();
    if (!trimmed) {
      throw new TaskError("description must be a non-empty string");
    }
    let id = generateId();
    while (this.tasks.has(id)) id = generateId();
    const task: Task = { id, description: trimmed, blockedBy: [], status: "pending" };
    this.tasks.set(id, task);
    await this.persist(task);
    return cloneTask(task);
  }

  async update(id: string, patch: TaskUpdatePatch): Promise<Task> {
    await this.ensureLoaded();
    const current = this.tasks.get(id);
    if (!current) {
      throw new TaskError(`task not found: ${id}`);
    }

    const hasStatus = patch.status !== undefined;
    const add = patch.addBlockedBy ?? [];
    const remove = patch.removeBlockedBy ?? [];
    const hasAdd = add.length > 0;
    const hasRemove = remove.length > 0;

    if (!hasStatus && !hasAdd && !hasRemove) {
      throw new TaskError(
        "updateTask requires at least one of status, addBlockedBy, removeBlockedBy",
      );
    }

    if (hasAdd && add.includes(id)) {
      throw new TaskError(`cannot add self (${id}) to blockedBy`);
    }

    if (hasAdd && hasRemove) {
      const overlap = add.filter((x) => remove.includes(x));
      if (overlap.length > 0) {
        throw new TaskError(
          `addBlockedBy and removeBlockedBy must not overlap: ${overlap.join(", ")}`,
        );
      }
    }

    if (hasStatus) {
      const next = patch.status as TaskStatus;
      const allowed = ALLOWED_TRANSITIONS[current.status];
      if (!allowed.includes(next)) {
        throw new TaskError(
          `invalid transition: ${current.status} -> ${next} ` +
            `(allowed from ${current.status}: ${allowed.join(", ") || "none"})`,
        );
      }
      current.status = next;
    }

    if (hasAdd || hasRemove) {
      const set = new Set(current.blockedBy);
      for (const x of add) set.add(x);
      for (const x of remove) set.delete(x);
      current.blockedBy = Array.from(set);
    }

    await this.persist(current);
    return cloneTask(current);
  }

  async get(id: string): Promise<Task | undefined> {
    await this.ensureLoaded();
    const t = this.tasks.get(id);
    return t ? cloneTask(t) : undefined;
  }

  async list(status?: TaskStatus): Promise<Task[]> {
    await this.ensureLoaded();
    const all = Array.from(this.tasks.values(), cloneTask);
    return status ? all.filter((t) => t.status === status) : all;
  }

  async clear(ids?: readonly string[]): Promise<void> {
    await this.ensureLoaded();
    if (ids === undefined) {
      this.tasks.clear();
      try {
        await fs.rm(this.tasksDir, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      return;
    }
    for (const id of ids) {
      this.tasks.delete(id);
      try {
        await fs.unlink(path.join(this.tasksDir, `${id}.json`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.tasksDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(this.tasksDir, entry), "utf8");
        const parsed = JSON.parse(content) as Partial<Task>;
        if (
          typeof parsed?.id === "string" &&
          typeof parsed?.description === "string" &&
          Array.isArray(parsed?.blockedBy) &&
          parsed.blockedBy.every((x) => typeof x === "string") &&
          (parsed?.status === "pending" ||
            parsed?.status === "in_progress" ||
            parsed?.status === "completed")
        ) {
          this.tasks.set(parsed.id, {
            id: parsed.id,
            description: parsed.description,
            blockedBy: parsed.blockedBy,
            status: parsed.status,
          });
        }
      } catch {
        // skip corrupted file
      }
    }
  }

  private async persist(task: Task): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true });
    const filePath = path.join(this.tasksDir, `${task.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(task, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  }
}
