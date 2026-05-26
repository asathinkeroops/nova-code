import { randomBytes } from "node:crypto";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  id: string;
  description: string;
  status: TodoStatus;
}

const ALLOWED_TRANSITIONS: Record<TodoStatus, readonly TodoStatus[]> = {
  pending: ["in_progress", "completed"],
  in_progress: ["completed", "pending"],
  completed: ["pending"],
};

function generateId(): string {
  return randomBytes(6).toString("base64url");
}

export class TodoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoError";
  }
}

export class TodoStore {
  private readonly todos = new Map<string, Todo>();

  create(description: string): Todo {
    const trimmed = description.trim();
    if (!trimmed) {
      throw new TodoError("description must be a non-empty string");
    }
    let id = generateId();
    while (this.todos.has(id)) id = generateId();
    const todo: Todo = { id, description: trimmed, status: "pending" };
    this.todos.set(id, todo);
    return { ...todo };
  }

  update(id: string, nextStatus: TodoStatus): Todo {
    const current = this.todos.get(id);
    if (!current) {
      throw new TodoError(`todo not found: ${id}`);
    }
    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.includes(nextStatus)) {
      throw new TodoError(
        `invalid transition: ${current.status} -> ${nextStatus} ` +
          `(allowed from ${current.status}: ${allowed.join(", ") || "none"})`,
      );
    }
    if (nextStatus === "in_progress") {
      const blocker = this.findInProgress();
      if (blocker && blocker.id !== id) {
        throw new TodoError(
          `cannot set ${id} to in_progress: ${blocker.id} is already in_progress. ` +
            `Move it to completed/error/pending first.`,
        );
      }
    }
    current.status = nextStatus;
    return { ...current };
  }

  list(status?: TodoStatus): Todo[] {
    const all = Array.from(this.todos.values(), (t) => ({ ...t }));
    return status ? all.filter((t) => t.status === status) : all;
  }

  get(id: string): Todo | undefined {
    const t = this.todos.get(id);
    return t ? { ...t } : undefined;
  }

  size(): number {
    return this.todos.size;
  }

  clear(ids?: readonly string[]): void {
    if (ids === undefined) {
      this.todos.clear();
      return;
    }
    for (const id of ids) this.todos.delete(id);
  }

  private findInProgress(): Todo | undefined {
    for (const t of this.todos.values()) {
      if (t.status === "in_progress") return t;
    }
    return undefined;
  }
}
