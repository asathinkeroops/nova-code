import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Todo, TodoStatus } from "@nova/orchestration";
import { MAGENTA_RGB, magenta } from "../colors.js";
import { Spinner } from "./spinner.js";
import type { SpinnerSpec } from "./store.js";

const MAX_VISIBLE = 5;

const STATUS_RANK: Record<TodoStatus, number> = {
  error: 0,
  in_progress: 1,
  pending: 2,
  completed: 3,
};

export interface TodoFooterProps {
  todos: Todo[];
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
    case "error":
      return (
        <Text>
          {prefix}
          <Text color="red">✗</Text>{" "}
          <Text color="red">{todo.description}</Text>
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
      <Text dimColor>
        ... {hidden} More, {counts.completed} completed, {counts.pending} pending,{" "}
        {counts.in_progress} in_progress, {counts.error} error
      </Text>
    </Text>
  );
}

// Priority of which todo's description becomes the spinner label. in_progress
// always wins (it's the "current task"); if none is in_progress, fall through
// to completed → pending → error so the spinner keeps a meaningful title as
// long as the list has any items.
const SPINNER_PRIORITY: TodoStatus[] = ["in_progress", "completed", "pending", "error"];

function pickSpinnerTodo(todos: Todo[]): Todo | undefined {
  for (const status of SPINNER_PRIORITY) {
    const hit = todos.find((t) => t.status === status);
    if (hit) return hit;
  }
  return undefined;
}

export function TodoFooter({ todos }: TodoFooterProps): React.ReactElement | null {
  const spinnerTodo = pickSpinnerTodo(todos);
  const spinnerId = spinnerTodo?.id;

  // Reset elapsed timer whenever the active todo (the one feeding the spinner
  // label) changes — each task has its own clock.
  const [startedAt, setStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (spinnerId) setStartedAt(Date.now());
  }, [spinnerId]);

  if (todos.length === 0) return null;

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
    error: 0,
  };
  for (const t of todos) counts[t.status] += 1;

  const spinnerSpec: SpinnerSpec | null = spinnerTodo
    ? {
        id: -1,
        label: { words: [spinnerTodo.description], tint: MAGENTA_RGB, colorize: magenta },
        startedAt,
        activeWord: spinnerTodo.description + '...',
      }
    : null;

  return (
    <Box flexDirection="column">
      {spinnerSpec ? <Spinner spec={spinnerSpec} /> : null}
      {visible.map((t, i) => (
        <TodoRow key={t.id} todo={t} isFirst={i === 0} />
      ))}
      {hidden > 0 ? <SummaryRow hidden={hidden} counts={counts} /> : null}
    </Box>
  );
}
