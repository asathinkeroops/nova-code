import React from "react";
import { Box } from "ink";
import { useShallow } from "zustand/react/shallow";
import { InputBox } from "./input-box.js";
import { userInputHistory } from "./input-history.js";
import { SetupView } from "./setup-view.js";
import { StatusLine } from "./status-line.js";
import type { AppStoreApi } from "./store.js";
import { Viewport } from "./viewport.js";

/**
 * Pinned bottom chrome row count: the always-present StatusLine plus the
 * InputBox. The InputBox reports its actual height via `onMeasure` (queued
 * prompts + popup + wrapped buffer + rules), so growing content reserves rows
 * instead of overlapping the viewport. In-stream modals (approval/ask/pick)
 * reserve their own rows inside the Viewport.
 */
function pinnedBottomRows(inputRows: number): number {
  return 1 + inputRows;
}

/** Floor for the pinned frame height so a tiny terminal still renders. */
const MIN_FRAME_ROWS = 4;

interface AppProps {
  store: AppStoreApi;
}

export function App({ store }: AppProps): React.ReactElement {
  const { setup, modal, slashCommands, inputPlaceholder, inputQueue, termRows } = store(
    useShallow((s) => ({
      setup: s.setup,
      modal: s.modal,
      slashCommands: s.slashCommands,
      inputPlaceholder: s.inputPlaceholder,
      inputQueue: s.inputQueue,
      termRows: s.termRows,
    })),
  );
  // Actions are stable across renders — grab them once via getState().
  const { resolveModal } = store.getState();

  // Ctrl+C: interrupt a running turn if one is active, else ask the idle REPL
  // to exit. Escape: interrupt only — never exits — and does nothing when idle.
  const onCtrlC = React.useCallback(() => {
    const s = store.getState();
    if (s.escHandler) s.escHandler();
    else s.requestExit();
  }, [store]);
  const onEscape = React.useCallback(() => {
    const h = store.getState().escHandler;
    if (h) h();
  }, [store]);
  const onSubmitInput = React.useCallback(
    (value: string) => store.getState().enqueueInput(value),
    [store],
  );

  // Default 3 = top rule + 1 input line + bottom rule (no popup, single-line
  // buffer). InputBox reports its real height via onMeasure as it grows.
  const [inputRows, setInputRows] = React.useState(3);
  const onMeasureInput = React.useCallback((rows: number) => setInputRows(rows), []);

  // Setup mode commandeers the whole screen — everything else (banner,
  // messages, cards, spinner, footer) is suppressed until the wizard finishes.
  // It still drives input through the modal prompt rather than the queue.
  if (setup) {
    return (
      <Box flexDirection="column">
        <SetupView state={setup} />
        {modal?.kind === "input" ? (
          <InputBox
            options={modal.opts}
            onSubmit={(value) => resolveModal(value)}
            onCancel={() => resolveModal(null)}
            onMeasure={onMeasureInput}
          />
        ) : null}
      </Box>
    );
  }

  // Leave a 1-row safety margin so the layout never sums to exactly termRows.
  // Some terminals (Warp) push content one row up when the live region fills
  // the screen edge-to-edge, which would clip the top of the viewport.
  const viewportRows = Math.max(3, termRows - pinnedBottomRows(inputRows) - 1);

  // The InputBox is a permanent fixture: it stays mounted (and visible) the
  // whole session so the user can type mid-turn. It only goes inert while an
  // in-stream modal owns input — passing active=false keeps the buffer intact.
  // Pin the whole frame to a fixed height and let only the Viewport flex. When
  // the slash popup grows the InputBox, it steals rows from the Viewport in the
  // same layout pass instead of overflowing the alt-screen for a frame (which
  // scrolls the terminal and reads as jitter). The pinned chrome keeps its
  // natural height via flexShrink={0}; overflowY clips any one-frame slack
  // while the measured `viewportRows` catches up. Height stays one row short of
  // the terminal so the live region never fills edge-to-edge (Warp pushes
  // content up otherwise).
  return (
    <Box flexDirection="column" height={Math.max(MIN_FRAME_ROWS, termRows - 1)} overflowY="hidden">
      <Viewport store={store} rows={viewportRows} resolveModal={resolveModal} />
      <Box flexShrink={0} flexDirection="column">
        <InputBox
          options={{
            commands: slashCommands,
            placeholder: inputPlaceholder,
            history: userInputHistory(store.getState().messages),
            queued: inputQueue,
          }}
          active={modal === null}
          onSubmit={onSubmitInput}
          onCancel={onCtrlC}
          onEscape={onEscape}
          onMeasure={onMeasureInput}
        />
      </Box>
      <Box flexShrink={0}>
        <StatusLine store={store} />
      </Box>
    </Box>
  );
}
