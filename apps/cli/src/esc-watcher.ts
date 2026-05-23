export interface EscWatcher {
  resume(): void;
  suspend(): void;
  dispose(): void;
}

/**
 * Puts stdin in raw mode and fires `onInterrupt` when the user presses bare
 * ESC or Ctrl+C. Arrow keys / function keys arrive as multi-byte sequences
 * (e.g. "\x1b[A") and won't match the exact ESC test.
 *
 * `suspend` is used when Ink takes over stdin (permission prompts, askUser):
 * the two raw-mode listeners can't coexist, so we release stdin while Ink
 * runs and `resume` reinstalls our handler afterward.
 */
export function watchForEscape(onInterrupt: () => void): EscWatcher {
  const stdin = process.stdin;
  let installed = false;

  const onData = (data: Buffer): void => {
    const s = data.toString("utf8");
    if (s === "\x1b" || s === "\x03") {
      onInterrupt();
    }
  };

  const install = (): void => {
    if (installed) return;
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return;
    try {
      stdin.setRawMode(true);
      try {
        (stdin as { ref?: () => void }).ref?.();
      } catch {
        // ignore
      }
      stdin.on("data", onData);
      stdin.resume();
      installed = true;
    } catch {
      // ignore — stdin may be in a bad state; we just won't catch ESC.
    }
  };

  const uninstall = (): void => {
    if (!installed) return;
    try {
      stdin.removeListener("data", onData);
    } catch {
      // ignore
    }
    try {
      stdin.setRawMode(false);
    } catch {
      // ignore
    }
    try {
      stdin.pause();
    } catch {
      // ignore
    }
    installed = false;
  };

  install();
  return { resume: install, suspend: uninstall, dispose: uninstall };
}
