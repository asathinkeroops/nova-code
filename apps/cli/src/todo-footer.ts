import type { Todo, TodoStatus } from "@nova/orchestration";
import { blue, bold, dim, gray, green, red, strike } from "./colors.js";

const MAX_VISIBLE = 5;

const STATUS_RANK: Record<TodoStatus, number> = {
  error: 0,
  in_progress: 1,
  pending: 2,
  completed: 3,
};

export function renderTodoHeader(todos: Todo[]): string[] {
  if (todos.length === 0) return [];
  const item = (t: Todo): string => {
    switch (t.status) {
      case "completed":
        return `${green("✓")} ${gray(strike(t.description))}`;
      case "in_progress":
        return `${blue("■")} ${bold(blue(t.description))}`;
      case "error":
        return `${red("✗")} ${red(t.description)}`;
      case "pending":
      default:
        return `□ ${t.description}`;
    }
  };
  // Stable sort by status priority; original ordering preserved within a status.
  const sorted = todos
    .map((t, i) => ({ t, i }))
    .sort((a, b) => STATUS_RANK[a.t.status] - STATUS_RANK[b.t.status] || a.i - b.i)
    .map(({ t }) => t);
  const visible = sorted.slice(0, MAX_VISIBLE);
  const lines = visible.map((t, i) =>
    i === 0 ? `${dim("  ⎿  ")}${item(t)}` : `     ${item(t)}`,
  );
  if (sorted.length > MAX_VISIBLE) {
    const counts = { completed: 0, pending: 0, in_progress: 0, error: 0 };
    for (const t of sorted) counts[t.status] += 1;
    lines.push(
      `     ${dim(`... ${sorted.length - MAX_VISIBLE} More, ${counts.completed} completed, ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.error} error`)}`,
    );
  }
  return lines;
}
