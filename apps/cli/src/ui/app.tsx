import React from "react";
import { Box, Text } from "ink";
import { useShallow } from "zustand/react/shallow";
import { InputBox } from "./input-box.js";
import { SetupView } from "./setup-view.js";
import { TrustView } from "./trust-view.js";
import { StatusLine } from "./status-line.js";
import {
  backgroundStatusLabel,
  permissionModeIndicator,
  permissionModeHint,
} from "./status-format.js";
import { BackgroundStatus } from "./background-status.js";
import { setCursorTarget } from "./cursor-target.js";
import {
  PickHorizontal,
  PickList,
  type HorizontalPickerOptions,
  type PickerOptions,
} from "./picker.js";
import type { AppStoreApi } from "./store.js";
import { Viewport } from "./viewport.js";
import { truncateToWidth, visibleWidth } from "./width.js";
import { setJumpButtonBounds } from "./jump-button.js";
import { t } from "../i18n/index.js";

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

/**
 * Right-aligned button occupying the spacer row above the InputBox while the
 * user has scrolled up (stickToBottom=false) and no modal owns the input. It
 * always renders exactly INPUT_TOP_SPACER_ROWS tall — visible or not — so it
 * never reflows the pinned-bottom row budget.
 *
 * End / ctrl+End (intercepted in mouse.ts) or a click on the button scroll back
 * to the bottom and hide it. While shown, it registers its absolute screen
 * position (`setJumpButtonBounds`) so the Screen-level mouse handlers can hover-
 * highlight and click it; `jumpButtonHovered` in the store drives the highlight.
 */
function JumpToBottomHint({
  store,
  enabled,
  termRows,
  termCols,
  inputRows,
  indicatorRows,
}: {
  store: AppStoreApi;
  enabled: boolean;
  termRows: number;
  termCols: number;
  inputRows: number;
  indicatorRows: number;
}): React.ReactElement {
  const stickToBottom = store((s) => s.stickToBottom);
  const hovered = store((s) => s.jumpButtonHovered);
  const show = enabled && !stickToBottom;

  // Read at render time — never at module top-level (see i18n invariant).
  const label = t.render.jumpToBottom;
  const labelWidth = visibleWidth(label);

  // Absolute 1-indexed screen position, derived from the pinned-bottom layout:
  // the button is the single spacer row directly above the InputBox, centered.
  const frameRows = Math.max(MIN_FRAME_ROWS, termRows - 1);
  const row = Math.max(1, frameRows - inputRows - STATUS_LINE_ROWS - indicatorRows);
  const colStart = Math.max(1, Math.floor((termCols - labelWidth) / 2) + 1);
  const colEnd = colStart + labelWidth - 1;

  React.useEffect(() => {
    if (!show) return;
    setJumpButtonBounds({ row, colStart, colEnd });
    return () => {
      setJumpButtonBounds(null);
      store.getState().setJumpButtonHovered(false);
    };
  }, [show, row, colStart, colEnd, store]);

  return (
    <Box flexShrink={0} height={INPUT_TOP_SPACER_ROWS} justifyContent="center">
      {show ? (
        <Text color="black" backgroundColor={hovered ? "cyan" : "gray"}>
          {label}
        </Text>
      ) : null}
    </Box>
  );
}

/** Floor for the pinned frame height so a tiny terminal still renders. */
const MIN_FRAME_ROWS = 4;

interface AppProps {
  store: AppStoreApi;
}

export function App({ store }: AppProps): React.ReactElement {
  const {
    setup,
    trust,
    modal,
    slashCommands,
    mentionFiles,
    inputPlaceholder,
    inputQueue,
    inputHistory,
    sessionName,
    permissionMode,
    termRows,
    termCols,
    imagePaste,
    runningBackgroundCount,
  } = store(
    useShallow((s) => ({
      setup: s.setup,
      trust: s.trust,
      modal: s.modal,
      slashCommands: s.slashCommands,
      mentionFiles: s.mentionFiles,
      inputPlaceholder: s.inputPlaceholder,
      inputQueue: s.inputQueue,
      inputHistory: s.inputHistory,
      sessionName: s.sessionName,
      permissionMode: s.permissionMode,
      termRows: s.termRows,
      termCols: s.termCols,
      imagePaste: s.imagePaste,
      runningBackgroundCount: s.runningBackgroundCount,
    })),
  );
  // Actions are stable across renders — grab them once via getState().
  const { resolveModal } = store.getState();

  // The pick / pickH / viewer modals are full popup overlays ("弹层"): while one
  // is open it owns the screen, so the pinned bottom chrome (InputBox +
  // StatusLine + mode indicator) is hidden and its reserved rows are handed to
  // the Viewport that hosts the overlay. (approval / ask keep the chrome — they
  // have distinct prompt semantics and aren't full-screen popups.)
  const overlayModal =
    modal !== null &&
    (modal.kind === "pick" ||
      modal.kind === "pickH" ||
      modal.kind === "slider" ||
      modal.kind === "viewer");

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

  // The permanent InputBox owns the real-cursor target; while setup commandeers
  // the screen — or a full-screen overlay hides the InputBox — it isn't mounted,
  // so clear the target ourselves so the cursor doesn't park at a stale caret.
  React.useEffect(() => {
    if (setup || trust || overlayModal) setCursorTarget(null);
  }, [setup, trust, overlayModal]);

  // Full-screen gates (provider setup, workspace trust) commandeer the whole
  // screen — banner, messages, cards, spinner, footer all stay hidden until the
  // gate returns. Setup and trust are independent concerns with their own views;
  // they only share this generic host, which renders the active view plus any
  // open modal (the setup wizard drives input; trust shows a Yes/No picker).
  const fullscreenView = setup ? (
    <SetupView state={setup} />
  ) : trust ? (
    <TrustView state={trust} />
  ) : null;
  if (fullscreenView) {
    return (
      <Box flexDirection="column">
        {fullscreenView}
        {modal?.kind === "input" ? (
          <InputBox
            options={modal.opts}
            onSubmit={(value) => resolveModal(value)}
            onCancel={() => resolveModal(null)}
            onMeasure={onMeasureInput}
          />
        ) : null}
        {modal?.kind === "pickH" ? (
          <PickHorizontal
            opts={modal.opts as HorizontalPickerOptions<unknown>}
            onResolve={(value) => resolveModal(value)}
          />
        ) : null}
        {modal?.kind === "pick" ? (
          <PickList
            opts={modal.opts as PickerOptions<unknown>}
            onResolve={(value) => resolveModal(value)}
          />
        ) : null}
      </Box>
    );
  }

  // Mode indicator below the StatusLine — one extra reserved row, always
  // present since every permission mode has a label (`default` shows a light
  // grey "manual mode on"). Shell mode takes over the StatusLine row itself
  // (segments hidden, only the `!` hint), so it suppresses this separate row
  // entirely — the only case where the row is reclaimed. The bypass mode is just
  // another cycled mode now (red label), so it carries the shift+tab hint like
  // the rest.
  const modeIndicator = shellMode ? null : permissionModeIndicator(permissionMode);
  const indicatorRows = modeIndicator ? 1 : 0;
  const rawBackgroundStatus = backgroundStatusLabel(runningBackgroundCount);
  const modeRowWidth = modeIndicator
    ? visibleWidth(` ${modeIndicator.label} ${permissionModeHint()}`)
    : 0;
  const backgroundWidth = Math.max(0, termCols - modeRowWidth - 4);
  const backgroundStatus =
    rawBackgroundStatus && backgroundWidth >= 8
      ? truncateToWidth(rawBackgroundStatus, backgroundWidth - 2)
      : null;

  // Leave a 1-row safety margin so the layout never sums to exactly termRows.
  // Some terminals (Warp) push content one row up when the live region fills
  // the screen edge-to-edge, which would clip the top of the viewport. A
  // full-screen overlay hides the bottom chrome, so reclaim all of its rows.
  const bottomChromeRows = overlayModal ? 0 : pinnedBottomRows(inputRows, indicatorRows);
  const viewportRows = Math.max(3, termRows - bottomChromeRows - 1);

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
      {overlayModal ? null : (
        <>
          <JumpToBottomHint
            store={store}
            enabled={modal === null}
            termRows={termRows}
            termCols={termCols}
            inputRows={inputRows}
            indicatorRows={indicatorRows}
          />
          <Box flexShrink={0} flexDirection="column">
            <InputBox
              options={{
                commands: slashCommands,
                files: mentionFiles,
                placeholder: inputPlaceholder,
                history: inputHistory,
                queued: inputQueue,
                ...(sessionName ? { sessionName } : {}),
              }}
              active={modal === null}
              onSubmit={onSubmitInput}
              onCancel={onCtrlC}
              onEscape={onEscape}
              onMeasure={onMeasureInput}
              onCyclePermissionMode={onCyclePermissionMode}
              onShellModeChange={setShellMode}
              cursorTracking={{
                termRows,
                bottomChromeRows: STATUS_LINE_ROWS + indicatorRows,
              }}
              onClipboardPaste={imagePaste?.capture}
              onImageAttached={imagePaste?.attached}
            />
          </Box>
          <Box flexShrink={0} flexDirection="column">
            <StatusLine store={store} shellMode={shellMode} />
            {modeIndicator ? (
              <Box>
                <Text bold color={modeIndicator.color}>{` ${modeIndicator.label}`}</Text>
                <Text dimColor>{` ${permissionModeHint()}`}</Text>
                {backgroundStatus ? (
                  <>
                    <Text dimColor>{" │ "}</Text>
                    <BackgroundStatus label={backgroundStatus} />
                  </>
                ) : null}
              </Box>
            ) : null}
          </Box>
        </>
      )}
    </Box>
  );
}
