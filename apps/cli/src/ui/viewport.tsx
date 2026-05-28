import React from "react";
import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { ApprovalPrompt } from "./approval.js";
import { AskPanel } from "./ask-user.js";
import { sliceLines } from "./measure.js";
import { highlightLines } from "./selection.js";
import {
  type HorizontalPickerOptions,
  type PickerOptions,
  PickHorizontal,
  PickList,
} from "./picker.js";
import { buildRenderItems } from "./render-item.js";
import { blinkPendingOff, hasPendingDot } from "./render-strings.js";
import { Spinner } from "./spinner.js";
import type { AppStoreApi, ModalState } from "./store.js";
import { TaskFooter } from "./task-footer.js";
import { TodoFooter } from "./todo-footer.js";

const MIN_ROWS = 3;

export interface ViewportProps {
  store: AppStoreApi;
  /** Available vertical rows for the viewport region (text + in-stream chrome). */
  rows: number;
  /** Resolver for whatever modal is currently in the stream (approval/ask/pick). */
  resolveModal: (value: unknown) => void;
}

/**
 * The scrolling history pane. Hosts both immutable text items (banner,
 * messages, cards) and the live in-stream chrome (spinner, todo/task
 * footers, non-input modals) so everything visually flows with the
 * conversation. Only the input box stays pinned outside.
 *
 * Text content is bottom-aligned within the available rows so when history
 * is short, padding sits at the top and chrome lands right after the latest
 * message — feeling like a natural continuation rather than a floating
 * footer.
 */
export function Viewport({ store, rows, resolveModal }: ViewportProps): React.ReactElement {
  const {
    banner,
    messages,
    cards,
    thinkingLabel,
    termCols,
    scrollOffset,
    stickToBottom,
    spinner,
    modal,
    todos,
    tasks,
    selection,
  } = store(
    useShallow((s) => ({
      banner: s.banner,
      messages: s.messages,
      cards: s.cards,
      thinkingLabel: s.thinkingLabel,
      termCols: s.termCols,
      scrollOffset: s.scrollOffset,
      stickToBottom: s.stickToBottom,
      spinner: s.spinner,
      modal: s.modal,
      todos: s.todos,
      tasks: s.tasks,
      selection: s.selection,
    })),
  );
  const reportViewportMetrics = store.getState().reportViewportMetrics;
  const scrollBy = store.getState().scrollBy;

  const items = React.useMemo(
    () =>
      buildRenderItems({
        banner,
        showBannerHint: banner !== null,
        messages,
        cards,
        ...(thinkingLabel !== undefined ? { thinkingLabel } : {}),
      }),
    [banner, messages, cards, thinkingLabel],
  );

  // Reserve rows for in-stream chrome (spinner / modal / footers) that
  // render as React components below the text region but inside the same
  // viewport box. Conservative estimates — over-reservation just shows a
  // row or two of padding above the text; under-reservation pushes content
  // up by 1-2 rows (terminal scroll) which alt-screen absorbs cleanly.
  const inStreamModal = modal && modal.kind !== "input" ? modal : null;
  const chromeRows = chromeRowsFor(spinner, inStreamModal, todos.length, tasks.length);

  const usable = Math.max(MIN_ROWS, rows);
  const textRows = Math.max(1, usable - chromeRows);
  const effectiveOffset = stickToBottom ? Number.MAX_SAFE_INTEGER : scrollOffset;
  const slice = sliceLines(items, termCols, effectiveOffset, textRows);

  React.useEffect(() => {
    reportViewportMetrics(slice.totalLines, textRows);
  }, [reportViewportMetrics, slice.totalLines, textRows]);

  // Hand the visible lines to the store so the mouse-drag handler can map
  // terminal (row, col) coordinates back to characters when copying.
  const setVisibleLines = store.getState().setVisibleLines;
  React.useEffect(() => {
    setVisibleLines(slice.lines);
  }, [setVisibleLines, slice.lines]);

  // When a drag is in flight, paint the selected range in inverse video so
  // the user sees what they're selecting. Recomputed only when selection or
  // the underlying lines change — cheap for typical small selections.
  const highlighted = React.useMemo(
    () => (selection ? highlightLines(slice.lines, selection) : slice.lines),
    [slice.lines, selection],
  );

  // Blink the pending tool dot. The dot is baked into the static transcript
  // text, so we can't animate it with an Ink prop; instead we run a timer only
  // while a pending dot is visible and swap it for a blank "off" frame on the
  // (few) visible lines each tick — no full transcript re-render.
  const hasPending = React.useMemo(
    () => highlighted.some((l) => hasPendingDot(l)),
    [highlighted],
  );
  const [blinkOn, setBlinkOn] = React.useState(true);
  React.useEffect(() => {
    if (!hasPending) {
      setBlinkOn(true);
      return;
    }
    const id = setInterval(() => setBlinkOn((on) => !on), 450);
    return () => clearInterval(id);
  }, [hasPending]);
  const displayLines =
    hasPending && !blinkOn ? highlighted.map((l) => blinkPendingOff(l)) : highlighted;

  // Top-align content + chrome, then a flex-grow Box absorbs whatever vertical
  // space is left. This keeps the banner at row 1 on startup, prevents the
  // existing rows from jumping up when a new message lands (since the new
  // line just appends at the bottom of the text), and still anchors chrome
  // (spinner / modal / footers) immediately below the latest message.
  return (
    <Box flexDirection="column" height={usable}>
      {displayLines.length > 0 ? <Text>{displayLines.join("\n")}</Text> : null}
      {inStreamModal ? (
        <InStreamModal modal={inStreamModal} resolveModal={resolveModal} onScroll={scrollBy} />
      ) : spinner && todos.length === 0 && tasks.length === 0 ? (
        <Spinner spec={spinner} />
      ) : null}
      {spinner && (todos.length > 0 || tasks.length > 0) ? (
        <>
          <TaskFooter tasks={tasks} />
          <TodoFooter todos={todos} />
        </>
      ) : null}
      <Box flexGrow={1} />
    </Box>
  );
}

/**
 * Conservative row estimate for the in-stream chrome region. Matches the
 * components' actual render heights closely enough that the bottom of the
 * text region lands right above them; off-by-one is absorbed by alt-screen.
 */
function chromeRowsFor(
  spinner: { id: number } | null,
  modal: ModalState | null,
  todos: number,
  tasks: number,
): number {
  if (modal) {
    switch (modal.kind) {
      case "approval":
        // Layout breakdown (see approval.tsx):
        //   chrome:   marginTop(1) + border(1) + padding(1) on each side = 6
        //   content:  preview(1) + gap(1)+3 options + gap(1)+hint(1) = 7
        return 13;
      case "ask":
        return 10;
      case "pick":
        return Math.min(12, Math.max(3, modal.opts.items.length + 2));
      case "pickH":
        return 3;
      default:
        return 0;
    }
  }
  let n = 0;
  if (spinner) {
    // The standalone spinner line carries a blank above and below (marginTop +
    // marginBottom); when todos/tasks render instead, only its top spacing
    // applies since the footers replace the line.
    n += todos === 0 && tasks === 0 ? 3 : 2;
  }
  if (todos > 0 || tasks > 0) n += todos + tasks;
  return n;
}

function InStreamModal({
  modal,
  resolveModal,
  onScroll,
}: {
  modal: ModalState;
  resolveModal: (value: unknown) => void;
  onScroll: (delta: number) => void;
}): React.ReactElement | null {
  switch (modal.kind) {
    case "approval":
      return (
        <ApprovalPrompt
          decision={modal.decision}
          input={modal.input}
          {...(modal.onCancel ? { onCancel: modal.onCancel } : {})}
          onAnswer={(value) => resolveModal(value)}
          onScroll={onScroll}
        />
      );
    case "ask":
      return <AskPanel req={modal.req} onResolve={(value) => resolveModal(value)} />;
    case "pick":
      return (
        <PickList
          opts={modal.opts as PickerOptions<unknown>}
          onResolve={(value) => resolveModal(value)}
        />
      );
    case "pickH":
      return (
        <PickHorizontal
          opts={modal.opts as HorizontalPickerOptions<unknown>}
          onResolve={(value) => resolveModal(value)}
        />
      );
    default:
      return null;
  }
}
