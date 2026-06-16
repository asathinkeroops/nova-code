import React from "react";
import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { InputBox } from "./input-box.js";
import { userInputHistory } from "./input-history.js";
import { SetupView } from "./setup-view.js";
import { StatusLine } from "./status-line.js";
import {
  permissionModeIndicator,
  BYPASS_PERMISSIONS_INDICATOR,
  PERMISSION_MODE_HINT,
} from "./status-format.js";
import type { AppStoreApi } from "./store.js";
import { Viewport } from "./viewport.js";

/**
 * Pinned bottom chrome row count: a blank spacer row above the InputBox, the
 * InputBox itself, and the always-present two-row StatusLine (status + usage).
 * The spacer keeps the message stream from butting up against the input frame.
 * The InputBox reports its actual height via `onMeasure` (queued prompts +
 * popup + wrapped buffer + rules), so growing content reserves rows instead of
 * overlapping the viewport. In-stream modals (approval/ask/pick) reserve their
 * own rows inside the Viewport. `extraRows` covers optional chrome below the
 * StatusLine (the permission-mode indicator).
 */
function pinnedBottomRows(inputRows: number, extraRows: number): number {
  return STATUS_LINE_ROWS + INPUT_TOP_SPACER_ROWS + inputRows + extraRows;
}

/** Rows the StatusLine always occupies: the status row plus the usage row. */
const STATUS_LINE_ROWS = 2;

/** Blank rows held between the viewport and the InputBox so they aren't cramped. */
const INPUT_TOP_SPACER_ROWS = 1;

/** Floor for the pinned frame height so a tiny terminal still renders. */
const MIN_FRAME_ROWS = 4;

interface AppProps {
  store: AppStoreApi;
}

export function App({ store }: AppProps): React.ReactElement {
  const {
    setup,
    modal,
    slashCommands,
    mentionFiles,
    inputPlaceholder,
    inputQueue,
    permissionMode,
    skipPermissions,
    termRows,
  } = store(
    useShallow((s) => ({
      setup: s.setup,
      modal: s.modal,
      slashCommands: s.slashCommands,
      mentionFiles: s.mentionFiles,
      inputPlaceholder: s.inputPlaceholder,
      inputQueue: s.inputQueue,
      permissionMode: s.permissionMode,
      skipPermissions: s.skipPermissions,
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
  // Whether the permanent input is in shell (`!`) mode — drives the status-row
  // hint. Only the permanent InputBox reports this (modal/setup don't wire it).
  const [shellMode, setShellMode] = React.useState(false);
  const onCyclePermissionMode = React.useCallback(
    () => store.getState().cyclePermissionMode(),
    [store],
  );

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

  // Mode indicator below the StatusLine — one extra reserved row when a
  // non-default permission mode is active, nothing in default mode. Shell mode
  // takes over the StatusLine row itself (segments hidden, only the `!` hint),
  // so it suppresses this separate row entirely; otherwise the
  // dangerously-skip-permissions bypass wins over the cycled mode label and
  // drops the shift+tab hint (it is a startup flag, not a cycled mode).
  const modeIndicator = shellMode
    ? null
    : skipPermissions
      ? BYPASS_PERMISSIONS_INDICATOR
      : permissionModeIndicator(permissionMode);
  const indicatorRows = modeIndicator ? 1 : 0;

  // Leave a 1-row safety margin so the layout never sums to exactly termRows.
  // Some terminals (Warp) push content one row up when the live region fills
  // the screen edge-to-edge, which would clip the top of the viewport.
  const viewportRows = Math.max(3, termRows - pinnedBottomRows(inputRows, indicatorRows) - 1);

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
      <Box flexShrink={0} height={INPUT_TOP_SPACER_ROWS} />
      <Box flexShrink={0} flexDirection="column">
        <InputBox
          options={{
            commands: slashCommands,
            files: mentionFiles,
            placeholder: inputPlaceholder,
            history: userInputHistory(store.getState().messages),
            queued: inputQueue,
          }}
          active={modal === null}
          onSubmit={onSubmitInput}
          onCancel={onCtrlC}
          onEscape={onEscape}
          onMeasure={onMeasureInput}
          onCyclePermissionMode={onCyclePermissionMode}
          onShellModeChange={setShellMode}
        />
      </Box>
      <Box flexShrink={0} flexDirection="column">
        <StatusLine store={store} shellMode={shellMode} />
        {modeIndicator ? (
          <Box>
            <Text color={modeIndicator.color}>{` ${modeIndicator.label}`}</Text>
            {skipPermissions ? null : <Text dimColor>{` ${PERMISSION_MODE_HINT}`}</Text>}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
