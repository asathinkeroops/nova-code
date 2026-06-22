import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readClipboardText, saveClipboardImage } from "./ui/clipboard.js";

/**
 * Image input is unified into a *file path*: a pasted (Ctrl+V) or drag-dropped
 * image becomes a file on disk, and the input box inserts its path as plain
 * text. Nothing downstream changes — the path rides the normal string prompt
 * and the model reads it through the `read` tool (which already returns image
 * blocks, gated on the model's image modality). This keeps `runTurn(string)`
 * untouched.
 */

/** Extensions the model API can consume as image blocks (mirrors the read tool). */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Whether `p` ends in a supported image extension (case-insensitive). */
export function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTS.has(p.slice(dot).toLowerCase());
}

/** What a Ctrl+V pulled off the clipboard: a saved image file, or plain text. */
export type ClipboardPaste =
  | { kind: "image"; path: string }
  | { kind: "text"; text: string };

/**
 * Read the clipboard for a Ctrl+V paste: prefer an image (saved into `dir` and
 * returned as a path), otherwise fall back to plain text so binding Ctrl+V never
 * eats a normal paste. Returns null when the clipboard is empty / unreadable.
 */
export async function readClipboard(dir: string): Promise<ClipboardPaste | null> {
  const path = await captureClipboardImage(dir);
  if (path) return { kind: "image", path };
  const text = await readClipboardText();
  if (text) return { kind: "text", text };
  return null;
}

/**
 * Capture an image from the system clipboard into `dir` and return its absolute
 * path, or null when the clipboard holds no image (or no helper is available).
 * Creates `dir` on demand. Best-effort: never throws.
 */
export async function captureClipboardImage(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    // A monotonic-enough name; collisions within the same millisecond are
    // harmless since each capture overwrites a fresh file it just named.
    const dest = join(dir, `pasted-${Date.now()}.png`);
    const ok = await saveClipboardImage(dest);
    return ok ? dest : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a pasted chunk that is a single drag-and-dropped image path into a
 * clean absolute path, or null when the chunk isn't one. Handles the shapes
 * terminals produce on drop: surrounding single/double quotes, backslash-escaped
 * spaces (iTerm2), `~` expansion, and `file://` URLs. Returns null for ordinary
 * text so normal pastes are never mangled.
 */
export function normalizeDroppedImagePath(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.includes("\n")) return null;

  // Strip one layer of matching surrounding quotes (macOS Terminal drop).
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1);
  }

  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
  }

  // Unescape shell-escaped specials only (iTerm2 escapes spaces/parens with
  // `\`). Restricting to shell metacharacters leaves Windows separators like
  // `C:\Users\me` intact — there a `\` is a path separator, not an escape.
  s = s.replace(/\\([ ()'"&;|<>$`\\])/g, "$1");

  if (s.startsWith("~/")) s = join(homedir(), s.slice(2));

  const looksAbsolute = isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s);
  if (!looksAbsolute || !isImagePath(s)) return null;
  return s;
}
