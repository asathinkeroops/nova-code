import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Task, TaskStatus } from "@nova/tools";
import { CYAN_RGB, cyan } from "../colors.js";
import { Spinner } from "./spinner.js";
import type { SpinnerSpec } from "./store.js";

const MAX_VISIBLE = 5;

const STATUS_RANK: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

export interface TaskFooterProps {
  tasks: Task[];
}

interface TaskRowProps {
  task: Task;
  isFirst: boolean;
}

function TaskRow({ task, isFirst }: TaskRowProps): React.ReactElement {
  const prefix = isFirst ? (
    <Text dimColor>{"  ⎿  "}</Text>
  ) : (
    <Text>{"     "}</Text>
  );
  const suffix =
    task.blockedBy.length > 0 ? (
      <Text dimColor>{` ⟵ ${task.blockedBy.length}`}</Text>
    ) : null;
  switch (task.status) {
    case "completed":
      return (
        <Text>
          {prefix}
          <Text color="green">✓</Text>{" "}
          <Text color="gray" strikethrough>
            {task.description}
          </Text>
          {suffix}
        </Text>
      );
    case "in_progress":
      return (
        <Text>
          {prefix}
          <Text color="cyan">■</Text>{" "}
          <Text color="cyan" bold>
            {task.description}
          </Text>
          {suffix}
        </Text>
      );
    case "pending":
    default:
      return (
        <Text>
          {prefix}
          {"□ "}
          {task.description}
          {suffix}
        </Text>
      );
  }
}

function SummaryRow({
  hidden,
  counts,
}: {
  hidden: number;
  counts: Record<TaskStatus, number>;
}): React.ReactElement {
  return (
    <Text>
      {"     "}
      <Text dimColor>
        ... {hidden} More, {counts.completed} completed, {counts.pending} pending,{" "}
        {counts.in_progress} in_progress
      </Text>
    </Text>
  );
}

// Same priority rule as TodoFooter — in_progress wins; if none, fall through
// to completed → pending so the spinner keeps a meaningful title as long as
// the list has any items. When multiple are in_progress, take the first in
// creation order.
const SPINNER_PRIORITY: TaskStatus[] = ["in_progress", "completed", "pending"];

function pickSpinnerTask(tasks: Task[]): Task | undefined {
  for (const status of SPINNER_PRIORITY) {
    const hit = tasks.find((t) => t.status === status);
    if (hit) return hit;
  }
  return undefined;
}

export function TaskFooter({ tasks }: TaskFooterProps): React.ReactElement | null {
  const spinnerTask = pickSpinnerTask(tasks);
  const spinnerId = spinnerTask?.id;

  // Reset elapsed timer whenever the active task (the one feeding the spinner
  // label) changes — each task has its own clock.
  const [startedAt, setStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (spinnerId) setStartedAt(Date.now());
  }, [spinnerId]);

  if (tasks.length === 0) return null;

  // Stable sort by status priority; original ordering preserved within a status.
  const sorted = tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => STATUS_RANK[a.t.status] - STATUS_RANK[b.t.status] || a.i - b.i)
    .map(({ t }) => t);
  const visible = sorted.slice(0, MAX_VISIBLE);
  const hidden = sorted.length - visible.length;

  const counts: Record<TaskStatus, number> = {
    completed: 0,
    pending: 0,
    in_progress: 0,
  };
  for (const t of tasks) counts[t.status] += 1;

  const spinnerSpec: SpinnerSpec | null = spinnerTask
    ? {
        id: -2,
        label: {
          words: [`TASK: ${spinnerTask.description}`],
          tint: CYAN_RGB,
          colorize: cyan,
        },
        startedAt,
        activeWord: `TASK: ${spinnerTask.description}...`,
      }
    : null;

  return (
    <Box flexDirection="column">
      {spinnerSpec ? <Spinner spec={spinnerSpec} /> : null}
      {visible.map((t, i) => (
        <TaskRow key={t.id} task={t} isFirst={i === 0} />
      ))}
      {hidden > 0 ? <SummaryRow hidden={hidden} counts={counts} /> : null}
    </Box>
  );
}
