import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isImagePath, normalizeDroppedImagePath } from "./image-paste.js";

describe("isImagePath", () => {
  it("accepts supported image extensions case-insensitively", () => {
    expect(isImagePath("/a/b.png")).toBe(true);
    expect(isImagePath("/a/b.JPG")).toBe(true);
    expect(isImagePath("/a/b.jpeg")).toBe(true);
    expect(isImagePath("/a/b.GIF")).toBe(true);
    expect(isImagePath("/a/b.webp")).toBe(true);
  });

  it("rejects non-image and extension-less paths", () => {
    expect(isImagePath("/a/b.txt")).toBe(false);
    expect(isImagePath("/a/b")).toBe(false);
    expect(isImagePath("notes.md")).toBe(false);
  });
});

describe("normalizeDroppedImagePath", () => {
  it("returns a bare absolute image path unchanged", () => {
    expect(normalizeDroppedImagePath("/Users/me/shot.png")).toBe("/Users/me/shot.png");
  });

  it("strips surrounding single and double quotes", () => {
    expect(normalizeDroppedImagePath("'/Users/me/my shot.png'")).toBe(
      "/Users/me/my shot.png",
    );
    expect(normalizeDroppedImagePath('"/Users/me/my shot.png"')).toBe(
      "/Users/me/my shot.png",
    );
  });

  it("unescapes backslash-escaped spaces (iTerm2 drag)", () => {
    expect(normalizeDroppedImagePath("/Users/me/my\\ shot.png")).toBe(
      "/Users/me/my shot.png",
    );
  });

  it("expands a leading ~", () => {
    expect(normalizeDroppedImagePath("~/shot.png")).toBe(join(homedir(), "shot.png"));
  });

  it("decodes a file:// URL", () => {
    expect(normalizeDroppedImagePath("file:///Users/me/a%20b.png")).toBe(
      "/Users/me/a b.png",
    );
  });

  it("accepts a Windows drive path", () => {
    expect(normalizeDroppedImagePath("C:\\Users\\me\\shot.png")).toBe(
      "C:\\Users\\me\\shot.png",
    );
  });

  it("rejects ordinary text so normal pastes are untouched", () => {
    expect(normalizeDroppedImagePath("just some words")).toBeNull();
    expect(normalizeDroppedImagePath("see /a/b.png and /c/d.png")).toBeNull();
    expect(normalizeDroppedImagePath("/a/b.png\n/c/d.png")).toBeNull();
  });

  it("rejects a relative or non-image path", () => {
    expect(normalizeDroppedImagePath("shot.png")).toBeNull();
    expect(normalizeDroppedImagePath("/Users/me/notes.txt")).toBeNull();
  });
});
