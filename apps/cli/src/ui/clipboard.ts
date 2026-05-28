import { spawn } from "node:child_process";

/**
 * Copy text to the system clipboard. Tries the platform-native command first
 * (`pbcopy` / `clip` / `xclip` / `xsel`) and falls back to the OSC 52 escape
 * sequence so the action still works over SSH or in containers where the
 * native binaries are unavailable.
 *
 * Best-effort: we don't await the spawned child — the call returns
 * synchronously after kicking it off. Failures are silently absorbed because
 * the user's recourse is the same as if we'd waited (try again, copy
 * manually).
 */
export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  const native = tryNativeCommand(text);
  // OSC 52 as well — costs nothing, and covers the SSH-without-native-binary
  // case. Modern terminals (iTerm2 with the setting on, Warp, kitty, wezterm,
  // tmux with set-clipboard on) consume it; others ignore the unknown escape.
  tryOsc52(text);
  return native;
}

function tryNativeCommand(text: string): boolean {
  const cmd = nativeCommand();
  if (!cmd) return false;
  try {
    const child = spawn(cmd.bin, cmd.args, {
      stdio: ["pipe", "ignore", "ignore"],
    });
    // Swallow ENOENT (binary missing) so a Linux box without `xclip` doesn't
    // crash the agent. The stdin stream also emits its own error when the
    // child fails to spawn — listen there too.
    child.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    child.stdin.write(text);
    child.stdin.end();
    return true;
  } catch {
    return false;
  }
}

function nativeCommand(): { bin: string; args: string[] } | null {
  if (process.platform === "darwin") return { bin: "pbcopy", args: [] };
  if (process.platform === "win32") return { bin: "clip", args: [] };
  // Linux / BSD: prefer xclip; xsel and wl-copy are fine too but xclip is the
  // most common default on desktop installs. The spawn fails silently if it's
  // missing; OSC 52 still has a shot at delivering the text.
  return { bin: "xclip", args: ["-selection", "clipboard"] };
}

function tryOsc52(text: string): void {
  if (!process.stdout.isTTY) return;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  try {
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
  } catch {
    // ignore
  }
}
