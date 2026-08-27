import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

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

/**
 * Capture an image from the system clipboard and write it to `destPath` as PNG.
 * Returns true when an image was found and written, false otherwise (nothing on
 * the clipboard, or no supported helper available). Best-effort and never
 * throws — the caller's recourse is to fall back to a typed path.
 *
 * Platform helpers:
 *   macOS   — JXA reads the pasteboard's native PNG/TIFF UTI; AppleScript is a
 *             compatibility fallback for legacy clipboard representations.
 *   Linux   — `wl-paste` (Wayland) or `xclip` (X11) pipe `image/png` to us.
 *   Windows — PowerShell `Clipboard::GetImage()` saves the PNG.
 */
export async function saveClipboardImage(destPath: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") return await saveMacClipboardImage(destPath);
    if (process.platform === "win32") return await saveWindowsClipboardImage(destPath);
    return await saveLinuxClipboardImage(destPath);
  } catch {
    return false;
  }
}

/** Spawn a command and resolve with its exit code and captured stdout bytes. */
function capture(bin: string, args: string[]): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ code: -1, stdout: Buffer.alloc(0) });
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
  });
}

/** PNG magic number — guards against a tool emitting an empty/non-image stream. */
function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

type CaptureCommand = (
  bin: string,
  args: string[],
) => Promise<{ code: number | null; stdout: Buffer }>;

/** @internal Exported so platform command selection can be tested without a live clipboard. */
export async function saveMacClipboardImage(
  dest: string,
  runCommand: CaptureCommand = capture,
): Promise<boolean> {
  // The clipboard image may live only in memory (copied from a chat app or
  // browser, never saved to disk). Read the native UTI instead of asking
  // AppleScript to coerce it to an old four-character class: apps such as IM
  // clients commonly publish `public.tiff`, and that coercion can fail with
  // error -1700 even though valid TIFF bytes are present on the pasteboard.
  if (await macPasteboardAs("public.png", dest, runCommand)) return true;

  // Many apps expose only a TIFF representation. Capture that, then convert to
  // PNG with macOS's built-in `sips` (the read tool consumes PNG/JPEG/…).
  const tiff = `${dest}.tiff`;
  if (await macPasteboardAs("public.tiff", tiff, runCommand)) {
    const { code } = await runCommand("sips", ["-s", "format", "png", tiff, "--out", dest]);
    await rm(tiff, { force: true }).catch(() => undefined);
    return code === 0;
  }

  // Older applications may still advertise only legacy pasteboard classes.
  // Preserve the previous AppleScript path as a compatibility fallback.
  if (await macClipboardAs("«class PNGf»", dest, runCommand)) return true;
  if (await macClipboardAs("«class TIFF»", tiff, runCommand)) {
    const { code } = await runCommand("sips", ["-s", "format", "png", tiff, "--out", dest]);
    await rm(tiff, { force: true }).catch(() => undefined);
    return code === 0;
  }
  return false;
}

/**
 * Write one native macOS pasteboard UTI to `dest` through AppKit. JXA gives us
 * direct access to the NSData advertised by the source application and avoids
 * AppleScript's lossy/coercion-dependent `the clipboard as «class …»` path.
 * The script and destination are separate argv entries, so no shell or script
 * escaping is involved.
 */
async function macPasteboardAs(
  uti: "public.png" | "public.tiff",
  dest: string,
  runCommand: CaptureCommand,
): Promise<boolean> {
  const script = [
    'ObjC.import("AppKit");',
    "function run(argv) {",
    "  const data = $.NSPasteboard.generalPasteboard.dataForType(argv[0]);",
    '  if (!data) return "none";',
    '  return data.writeToFileAtomically(argv[1], true) ? "ok" : "none";',
    "}",
  ].join("\n");
  const { code, stdout } = await runCommand("osascript", [
    "-l",
    "JavaScript",
    "-e",
    script,
    uti,
    dest,
  ]);
  return code === 0 && stdout.toString().trim() === "ok";
}

/**
 * Write the clipboard's `klass` representation (an AppleScript raw class literal
 * like `«class PNGf»`) to `dest`. Returns false when the clipboard holds no such
 * representation. Args are passed to osascript directly (no shell), so the path
 * needs no escaping.
 */
async function macClipboardAs(
  klass: string,
  dest: string,
  runCommand: CaptureCommand,
): Promise<boolean> {
  const script = [
    "on run argv",
    "set destPath to item 1 of argv",
    "try",
    `set imgData to (the clipboard as ${klass})`,
    "on error",
    'return "none"',
    "end try",
    "set fh to open for access (POSIX file destPath) with write permission",
    "set eof fh to 0",
    "write imgData to fh",
    "close access fh",
    'return "ok"',
    "end run",
  ];
  const args: string[] = [];
  for (const line of script) args.push("-e", line);
  args.push(dest);
  const { code, stdout } = await runCommand("osascript", args);
  return code === 0 && stdout.toString().trim() === "ok";
}

async function saveLinuxClipboardImage(dest: string): Promise<boolean> {
  const helpers: ReadonlyArray<readonly [string, string[]]> = [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [bin, args] of helpers) {
    const { code, stdout } = await capture(bin, args);
    if (code === 0 && isPng(stdout)) {
      await writeFile(dest, stdout);
      return true;
    }
  }
  return false;
}

async function saveWindowsClipboardImage(dest: string): Promise<boolean> {
  // Single-quote the path for PowerShell, escaping any embedded quote.
  const quoted = `'${dest.replace(/'/g, "''")}'`;
  const ps =
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
    "$img=[System.Windows.Forms.Clipboard]::GetImage(); " +
    `if($img -ne $null){ $img.Save(${quoted}, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } ` +
    "else { Write-Output 'none' }";
  const { stdout } = await capture("powershell", ["-NoProfile", "-STA", "-Command", ps]);
  return stdout.toString().trim() === "ok";
}

/**
 * Read plain text from the system clipboard, or null when it's empty / no helper
 * is available. Lets Ctrl+V fall back to a normal paste when the clipboard holds
 * text rather than an image (important where Ctrl+V *is* the paste key, e.g.
 * Windows). Best-effort and never throws.
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await capture("pbpaste", []);
      const t = stdout.toString("utf8");
      return t.length > 0 ? t : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await capture("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Clipboard -Raw",
      ]);
      // Get-Clipboard appends a trailing newline; drop one and normalize CRLF.
      const t = stdout.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
      return t.length > 0 ? t : null;
    }
    const helpers: ReadonlyArray<readonly [string, string[]]> = [
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-o"]],
    ];
    for (const [bin, args] of helpers) {
      const { code, stdout } = await capture(bin, args);
      if (code === 0 && stdout.length > 0) return stdout.toString("utf8");
    }
    return null;
  } catch {
    return null;
  }
}
