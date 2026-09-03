import React from "react";
import { Box, Text } from "ink";
import type { Todo, TodoStatus } from "@nova/tools";
import { magenta } from "../colors.js";
import { t } from "../i18n/index.js";
import { Spinner } from "./spinner.js";
import type { SpinnerSpec } from "./store.js";

const MAX_VISIBLE = 5;

// A lone todo is noise the model was told not to create in the first place; the
// checklist only earns screen space once it's genuinely multi-step. Exported so
// the viewport routes the spinner identically — the footer replaces the
// standalone spinner only when the footer actually renders.
export const MIN_VISIBLE_TODOS = 2;
export function todoFooterVisible(todos: Todo[]): boolean {
  return todos.length >= MIN_VISIBLE_TODOS;
}

const STATUS_RANK: Record<TodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

export interface TodoFooterProps {
  todos: Todo[];
  /**
   * Anchor for the spinner's elapsed clock. This is the SAME turn-start anchor
   * the standalone spinner uses (the store's `spinner.startedAt`), so the footer
   * counts up across the whole turn instead of resetting whenever the active
   * todo changes — matching the standalone spinner's timing behaviour. Falls
   * back to mount time only when no anchor is supplied (defensive; the viewport
   * only renders this footer while a spinner is active).
   */
  startedAt?: number;
}

interface TodoRowProps {
  todo: Todo;
  isFirst: boolean;
}

function TodoRow({ todo, isFirst }: TodoRowProps): React.ReactElement {
  const prefix = isFirst ? (
    <Text dimColor>{"  ⎿  "}</Text>
  ) : (
    <Text>{"     "}</Text>
  );
  switch (todo.status) {
    case "completed":
      return (
        <Text>
          {prefix}
          <Text color="green">✓</Text>{" "}
          <Text color="gray" strikethrough>
            {todo.description}
          </Text>
        </Text>
      );
    case "in_progress":
      return (
        <Text>
          {prefix}
          <Text color="blue">■</Text>{" "}
          <Text color="blue" bold>
            {todo.description}
          </Text>
        </Text>
      );
    case "pending":
    default:
      return (
        <Text>
          {prefix}
          {"□ "}
          {todo.description}
        </Text>
      );
  }
}

function SummaryRow({
  hidden,
  counts,
}: {
  hidden: number;
  counts: Record<TodoStatus, number>;
}): React.ReactElement {
  return (
    <Text>
      {"     "}
      <Text dimColor>{t.footer.summary(hidden, counts.completed, counts.pending, counts.in_progress)}</Text>
    </Text>
  );
}

// Priority of which todo's description becomes the spinner label. in_progress
// always wins (it's the "current task"); if none is in_progress, fall through
// to completed → pending so the spinner keeps a meaningful title as long as
// the list has any items.
const SPINNER_PRIORITY: TodoStatus[] = ["in_progress", "completed", "pending"];

function pickSpinnerTodo(todos: Todo[]): Todo | undefined {
  for (const status of SPINNER_PRIORITY) {
    const hit = todos.find((t) => t.status === status);
    if (hit) return hit;
  }
  return undefined;
}

export function TodoFooter({ todos, startedAt }: TodoFooterProps): React.ReactElement | null {
  const spinnerTodo = pickSpinnerTodo(todos);

  if (!todoFooterVisible(todos)) return null;

  // Stable sort by status priority; original ordering preserved within a status.
  const sorted = todos
    .map((t, i) => ({ t, i }))
    .sort((a, b) => STATUS_RANK[a.t.status] - STATUS_RANK[b.t.status] || a.i - b.i)
    .map(({ t }) => t);
  const visible = sorted.slice(0, MAX_VISIBLE);
  const hidden = sorted.length - visible.length;

  const counts: Record<TodoStatus, number> = {
    completed: 0,
    pending: 0,
    in_progress: 0,
  };
  for (const t of todos) counts[t.status] += 1;

  const spinnerSpec: SpinnerSpec | null = spinnerTodo
    ? {
        id: -1,
        label: {
          words: [`${t.footer.todoLabel} ${spinnerTodo.description}`],
          colorize: magenta,
        },
        startedAt: startedAt ?? Date.now(),
        activeWord: `${t.footer.todoLabel} ${spinnerTodo.description}...`,
      }
    : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {spinnerSpec ? <Spinner spec={spinnerSpec} /> : null}
      {visible.map((t, i) => (
        <TodoRow key={t.id} todo={t} isFirst={i === 0} />
      ))}
      {hidden > 0 ? <SummaryRow hidden={hidden} counts={counts} /> : null}
    </Box>
  );
}
