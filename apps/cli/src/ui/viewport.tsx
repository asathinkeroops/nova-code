import React from "react";
import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { ApprovalPrompt, approvalRows } from "./approval.js";
import { AskPanel, askRows } from "./ask-user.js";
import { countWrappedLines, sliceLines } from "./measure.js";
import { highlightLines } from "./selection.js";
import {
  type HorizontalPickerOptions,
  type PickerOptions,
  type ViewerOptions,
  PickHorizontal,
  PickList,
  ScrollViewer,
  viewerLineText,
} from "./picker.js";
import { type SliderPickerOptions, SliderPicker, sliderRows } from "./slider.js";
import { buildLiveDraftItems, buildRenderItems } from "./render-item.js";
import { highlightWholeLine } from "./selection.js";
import { blinkPendingOff, hasPendingDot } from "./render-strings.js";
import { Spinner } from "./spinner.js";
import type { AppStoreApi, ModalState } from "./store.js";
import { MIN_VISIBLE_TASKS, TaskFooter, taskFooterVisible } from "./task-footer.js";
import { MIN_VISIBLE_TODOS, TodoFooter, todoFooterVisible } from "./todo-footer.js";

const MIN_ROWS = 3;

/** Columns of horizontal padding on each side of the message flow. Exported
 *  so the mouse-selection coordinate mapping in screen.ts can account for it. */
export const H_PAD = 2;

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
 *
 * Memoized on its props. It subscribes to the store itself, so store updates
 * still reach it; what `memo` skips is the re-render App triggers whenever
 * *its* slice changes for reasons the viewport does not care about — a queued
 * prompt, a refreshed @-mention index, a new placeholder, a permission-mode
 * cycle, shell mode. All three props are stable references (the store, and
 * zustand actions defined once in the store closure) apart from `rows`, which
 * only moves when the terminal or the input box is resized.
 */
export const Viewport = React.memo(function Viewport({
  store,
  rows,
  resolveModal,
}: ViewportProps): React.ReactElement {
  const {
    banner,
    messages,
    cards,
    thinkingLabel,
    termCols,
    scrollOffset,
    stickToBottom,
    hasSpinner,
    spinnerStartedAt,
    liveDraft,
    modal,
    todos,
    tasks,
    selection,
    userDisplayOverrides,
    toolDetails,
    expandedItems,
    hoveredItem,
  } = store(
    useShallow((s) => ({
      banner: s.banner,
      messages: s.messages,
      cards: s.cards,
      thinkingLabel: s.thinkingLabel,
      termCols: s.termCols,
      scrollOffset: s.scrollOffset,
      stickToBottom: s.stickToBottom,
      // Only track spinner existence, not its internal frame/token counters.
      // The <Spinner> component animates independently; token-count updates
      // (store.setSpinnerTokens) no longer re-render the entire Viewport.
      hasSpinner: s.spinner !== null,
      // Turn-start anchor of the active spinner — stable within a turn (and
      // within a slash-command spinner), so subscribing to it re-renders the
      // Viewport only when the anchor actually changes (a turn start, or a new
      // command spinner), never on animation/token ticks. The footers use it so
      // their elapsed clock matches whatever standalone spinner is showing.
      spinnerStartedAt: s.spinner?.startedAt ?? undefined,
      liveDraft: s.liveDraft,
      modal: s.modal,
      todos: s.todos,
      tasks: s.tasks,
      selection: s.selection,
      userDisplayOverrides: s.userDisplayOverrides,
      toolDetails: s.toolDetails,
      expandedItems: s.expandedItems,
      hoveredItem: s.hoveredItem,
    })),
  );
  const reportViewportMetrics = store.getState().reportViewportMetrics;
  const scrollBy = store.getState().scrollBy;
  const setLineTargets = store.getState().setLineTargets;

  const baseItems = React.useMemo(
    () =>
      buildRenderItems({
        banner,
        messages,
        cards,
        userDisplayOverrides,
        toolDetails,
        expandedItems,
        ...(thinkingLabel !== undefined ? { thinkingLabel } : {}),
      }),
    [banner, messages, cards, thinkingLabel, userDisplayOverrides, toolDetails, expandedItems],
  );
  // Streaming draft items are built separately and appended, so the transcript's
  // measure-cache (keyed by item identity) stays warm while only the draft
  // re-renders per token. Memoized on the draft reference so the spinner's
  // animation tick doesn't rebuild it.
  const liveItems = React.useMemo(
    () => (liveDraft ? buildLiveDraftItems(liveDraft, thinkingLabel) : []),
    [liveDraft, thinkingLabel],
  );
  const items = React.useMemo(
    () => (liveItems.length > 0 ? [...baseItems, ...liveItems] : baseItems),
    [baseItems, liveItems],
  );

  // Content width accounting for horizontal padding so text wraps before the
  // terminal edge instead of butting against it.
  const innerWidth = Math.max(1, termCols - H_PAD * 2);

  // Reserve rows for in-stream chrome (spinner / modal / footers) that
  // render as React components below the text region but inside the same
  // viewport box. Conservative estimates — over-reservation just shows a
  // row or two of padding above the text; under-reservation pushes content
  // up by 1-2 rows (terminal scroll) which alt-screen absorbs cleanly.
  const inStreamModal = modal && modal.kind !== "input" ? modal : null;
  const anyFooterVisible = todoFooterVisible(todos) || taskFooterVisible(tasks);
  const usable = Math.max(MIN_ROWS, rows);
  // Clamp to usable-1 so the text region keeps at least one row; a modal taller
  // than the viewport (very short terminal) is the only case this bites.
  const chromeRows = Math.min(
    usable - 1,
    chromeRowsFor(hasSpinner, inStreamModal, todos.length, tasks.length, innerWidth),
  );
  const textRows = Math.max(1, usable - chromeRows);
  const effectiveOffset = stickToBottom ? Number.MAX_SAFE_INTEGER : scrollOffset;
  const slice = sliceLines(items, innerWidth, effectiveOffset, textRows);

  React.useEffect(() => {
    reportViewportMetrics(slice.totalLines, textRows);
  }, [reportViewportMetrics, slice.totalLines, textRows]);

  // Hand the visible lines + per-line click targets to the store so the mouse
  // layer can map terminal (row, col) coordinates back to characters (for copy)
  // and to a collapsible item — tool-batch or thinking (for click/hover).
  const setVisibleLines = store.getState().setVisibleLines;
  React.useEffect(() => {
    setVisibleLines(slice.lines);
  }, [setVisibleLines, slice.lines]);
  React.useEffect(() => {
    setLineTargets(slice.targets);
  }, [setLineTargets, slice.targets]);

  // When a drag is in flight, paint the selected range in inverse video so
  // the user sees what they're selecting. Recomputed only when selection or
  // the underlying lines change — cheap for typical small selections.
  // A hovered collapsible-item control row (tool-batch title / thinking hint)
  // gets a whole-line highlight (skipped while a selection is active so a drag
  // never fights the hover band).
  const highlighted = React.useMemo(() => {
    if (selection) return highlightLines(slice.lines, selection);
    if (hoveredItem === null) return slice.lines;
    const idx = slice.targets.indexOf(hoveredItem);
    if (idx === -1) return slice.lines;
    const out = slice.lines.slice();
    out[idx] = highlightWholeLine(out[idx] ?? "");
    return out;
  }, [slice.lines, slice.targets, selection, hoveredItem]);

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
  if (inStreamModal) {
    const modalEl = (
      <InStreamModal
        modal={inStreamModal}
        width={innerWidth}
        resolveModal={resolveModal}
        onScroll={scrollBy}
      />
    );
    // The approval prompt belongs to the pending tool_use at the tail of the
    // transcript, so it hugs the text (spacer *below* it) and reads as a direct
    // continuation of that call rather than a panel floating at the bottom. The
    // text slice is unchanged either way, so existing rows don't shift — only
    // the empty space moves from above the prompt to below it.
    if (inStreamModal.kind === "approval") {
      return (
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden" paddingX={H_PAD}>
          {displayLines.length > 0 ? <Text>{displayLines.join("\n")}</Text> : null}
          {modalEl}
          <Box flexGrow={1} />
        </Box>
      );
    }
    // Other modals (ask / pick / viewer) stay pinned to the bottom of the
    // viewport, right above the input box: the flex-grow box sits *between* the
    // history and the modal, so opening one doesn't shift existing content down
    // — the modal just claims the empty space below.
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden" paddingX={H_PAD}>
        {displayLines.length > 0 ? <Text>{displayLines.join("\n")}</Text> : null}
        <Box flexGrow={1} />
        {modalEl}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden" paddingX={H_PAD}>
      {displayLines.length > 0 ? <Text>{displayLines.join("\n")}</Text> : null}
      {/* A visible footer carries its own spinner and replaces the standalone
          one; route on whether either footer will actually render (>= 2 items),
          not on whether any todo/task exists — otherwise a lone item suppresses
          the standalone spinner without drawing a footer to take its place. */}
      {hasSpinner && !anyFooterVisible ? <SpinnerWrapper store={store} /> : null}
      {hasSpinner && anyFooterVisible ? (
        <>
          <TaskFooter tasks={tasks} startedAt={spinnerStartedAt} />
          <TodoFooter todos={todos} startedAt={spinnerStartedAt} />
        </>
      ) : null}
      <Box flexGrow={1} />
    </Box>
  );
});

/**
 * Thin wrapper that subscribes to the full spinner spec so token-count
 * updates (pushSpinnerTokens) re-render only this component. The Viewport
 * tracks only spinner *existence* and stays stable across spinner ticks.
 */
function SpinnerWrapper({
  store,
}: {
  store: AppStoreApi;
}): React.ReactElement | null {
  const spec = store((s) => s.spinner);
  if (!spec) return null;
  return <Spinner spec={spec} />;
}

/**
 * Conservative row estimate for the in-stream chrome region. Matches the
 * components' actual render heights closely enough that the bottom of the
 * text region lands right above them; off-by-one is absorbed by alt-screen.
 */
function chromeRowsFor(
  hasSpinner: boolean,
  modal: ModalState | null,
  todos: number,
  tasks: number,
  cols: number,
): number {
  if (modal) {
    switch (modal.kind) {
      case "approval":
        // Exact, width-aware height (see approvalRows in approval.tsx). A
        // hardcoded constant here under-reserved: it ignored the round border
        // and the detail line, which wraps and can be up to MAX_DETAIL_LINES
        // tall, so the message region painted over a multi-line modal.
        return approvalRows(modal.input, cols);
      case "ask":
        // Exact, width-aware height. A hardcoded constant under-reserved when
        // the question text wrapped or carried embedded newlines (e.g. the
        // sandbox re-run prompt), so the message region painted over it.
        return askRows(modal.req, cols);
      case "pick":
        return pickListRows(modal.opts as PickerOptions<unknown>, cols);
      case "pickH":
        return pickHorizontalRows(modal.opts as HorizontalPickerOptions<unknown>, cols);
      case "slider":
        return sliderRows(modal.opts as SliderPickerOptions<unknown>, cols);
      case "viewer":
        return viewerRows(modal.opts as ViewerOptions, cols);
      default:
        return 0;
    }
  }
  // A footer only renders (and only replaces the standalone spinner) once it
  // clears its visibility threshold; a lone item draws neither footer nor an
  // extra row, so it falls back to the standalone spinner's full reservation.
  const showTodos = todos >= MIN_VISIBLE_TODOS;
  const showTasks = tasks >= MIN_VISIBLE_TASKS;
  let n = 0;
  if (hasSpinner) {
    // The standalone spinner line carries a blank above and below (marginTop +
    // marginBottom); when a footer renders instead, only its top spacing
    // applies since the footer replaces the line.
    n += showTodos || showTasks ? 2 : 3;
  }
  if (showTodos) n += 1 + todos;
  if (showTasks) n += 1 + tasks;
  return n;
}

/**
 * Exact render height of `PickList` (picker.tsx): a round-bordered box with
 * top/bottom margins, wrapping an optional header, up to `pageSize` item rows,
 * an optional "(n/m)" indicator, and an optional footer. Header/footer/items
 * are measured for wrapping so a long header never gets under-reserved (which
 * would let the message text region paint over the picker).
 */
export function pickListRows(opts: PickerOptions<unknown>, cols: number): number {
  const pageSize = Math.max(1, opts.pageSize ?? 10);
  const visible = opts.items.slice(0, Math.min(opts.items.length, pageSize));
  const bordered = opts.border ?? true;
  // Full-width top-rule panels give each row a single truncated line (see
  // PickList), so an item never wraps regardless of description length.
  const fullWidth = !bordered && !!opts.topRuleColor;
  const inner = Math.max(1, bordered ? cols - 2 : cols); // round border eats 2 columns
  // marginTop(1) + marginBottom(1), plus borderTop+borderBottom when bordered,
  // or just borderTop(1) for a top-rule overlay (border:false + topRuleColor).
  let n = bordered ? 4 : opts.topRuleColor ? 3 : 2;
  if (opts.header) n += countWrappedLines(opts.header, inner);
  for (const it of visible) {
    n += fullWidth ? 1 : countWrappedLines(opts.render(it, false), inner);
  }
  if (opts.items.length > pageSize) n += 1; // indicator line
  if (opts.footer) n += countWrappedLines(opts.footer, inner);
  return n;
}

/**
 * Render height of `ScrollViewer` (picker.tsx): same box shape as PickList —
 * round border + top/bottom margins, optional header, up to `pageSize` content
 * rows, an optional position indicator, and an optional footer. Measured from
 * the first page; scrolling reuses the same row budget.
 */
export function viewerRows(opts: ViewerOptions, cols: number): number {
  const pageSize = Math.max(1, opts.pageSize ?? 20);
  const visible = opts.lines.slice(0, Math.min(opts.lines.length, pageSize));
  const bordered = opts.border ?? true;
  const inner = Math.max(1, bordered ? cols - 2 : cols);
  // Top-rule overlays (border:false + topRuleColor) render a single top border.
  let n = bordered ? 4 : opts.topRuleColor ? 3 : 2;
  if (opts.header) n += countWrappedLines(opts.header, inner);
  for (const line of visible) n += countWrappedLines(viewerLineText(line), inner);
  if (opts.lines.length > pageSize) n += 1; // indicator line
  if (opts.footer) n += countWrappedLines(opts.footer, inner);
  return n;
}

/**
 * Exact render height of `PickHorizontal` (picker.tsx): a round-bordered,
 * padded box with top/bottom margins, an optional header, a blank spacer, the
 * single row of buttons, another blank spacer, and an optional footer.
 */
export function pickHorizontalRows(opts: HorizontalPickerOptions<unknown>, cols: number): number {
  const bordered = opts.border ?? true;
  // Round box: border(2) + padding(2) eat 4 columns and 6 chrome rows (border 2
  // + margin 2 + vertical padding 2). Top-rule overlay: no side border/padding,
  // so just margin(2) + top rule(1) and the panel spans the full inner width.
  const inner = Math.max(1, bordered ? cols - 4 : cols);
  let n = bordered ? 6 : opts.topRuleColor ? 3 : 2;
  if (opts.header) n += countWrappedLines(opts.header, inner);
  n += 1 + 1 + 1; // blank spacer + buttons row + blank spacer
  if (opts.footer) n += countWrappedLines(opts.footer, inner);
  return n;
}

function InStreamModal({
  modal,
  width,
  resolveModal,
  onScroll,
}: {
  modal: ModalState;
  /** Width available to the modal box (viewport inner width). Threaded to the
   *  approval prompt so its `⎿` body wraps against the same content width that
   *  {@link approvalRows} reserved for. */
  width: number;
  resolveModal: (value: unknown) => void;
  onScroll: (delta: number) => void;
}): React.ReactElement | null {
  switch (modal.kind) {
    case "approval":
      return (
        <ApprovalPrompt
          decision={modal.decision}
          input={modal.input}
          width={width}
          {...(modal.onCancel ? { onCancel: modal.onCancel } : {})}
          onAnswer={(value) => resolveModal(value)}
          onScroll={onScroll}
        />
      );
    case "ask":
      return (
        <AskPanel
          req={modal.req}
          onResolve={(value) => resolveModal(value)}
          panelWidth={width}
        />
      );
    case "pick":
      return (
        <PickList
          opts={modal.opts as PickerOptions<unknown>}
          onResolve={(value) => resolveModal(value)}
          panelWidth={width}
        />
      );
    case "pickH":
      return (
        <PickHorizontal
          opts={modal.opts as HorizontalPickerOptions<unknown>}
          onResolve={(value) => resolveModal(value)}
          panelWidth={width}
        />
      );
    case "slider":
      return (
        <SliderPicker
          opts={modal.opts as SliderPickerOptions<unknown>}
          onResolve={(value) => resolveModal(value)}
          panelWidth={width}
        />
      );
    case "viewer":
      return (
        <ScrollViewer
          opts={modal.opts as ViewerOptions}
          onResolve={(value) => resolveModal(value)}
          panelWidth={width}
        />
      );
    default:
      return null;
  }
}
