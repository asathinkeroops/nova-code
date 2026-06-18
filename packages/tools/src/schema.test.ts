import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aliasedPath, PATH_ALIASES, withAliases } from "./schema.js";

const schema = withAliases(
  z.object({
    path: z.string().min(1),
    offset: z.number().int().optional(),
  }),
  { path: PATH_ALIASES },
);

describe("withAliases", () => {
  it("normalizes a filePath alias onto the canonical path key", () => {
    // The exact live failure: model paginates with offset but names the path `filePath`.
    const parsed = schema.parse({ offset: 139, filePath: "/abs/x.ts" });
    expect(parsed).toEqual({ path: "/abs/x.ts", offset: 139 });
  });

  it("accepts file_path and file aliases too", () => {
    expect(schema.parse({ file_path: "/a" })).toEqual({ path: "/a" });
    expect(schema.parse({ file: "/b" })).toEqual({ path: "/b" });
  });

  it("leaves the canonical key untouched and does not let an alias override it", () => {
    expect(schema.parse({ path: "/real", filePath: "/alias" })).toEqual({ path: "/real" });
  });

  it("still rejects when neither the canonical key nor any alias is present", () => {
    const r = schema.safeParse({ offset: 10 });
    expect(r.success).toBe(false);
  });

  it("still enforces the inner field constraints after normalization", () => {
    // empty alias value flows to `path` and fails min(1)
    expect(schema.safeParse({ filePath: "" }).success).toBe(false);
  });

  it("passes through non-object input untouched (inner schema reports the type error)", () => {
    expect(schema.safeParse("nope").success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  // Note: the guarantee that the model-facing wire schema still advertises only
  // the canonical `path` (zodToJsonSchema unwraps the preprocess to the inner
  // object) is owned by @nova/core's toWireTools, which holds the
  // zod-to-json-schema dependency; it isn't re-tested here.
});

describe("aliasedPath", () => {
  it("prefers the canonical path", () => {
    expect(aliasedPath({ path: "/p", filePath: "/q" })).toBe("/p");
  });

  it("falls back to each alias in order", () => {
    expect(aliasedPath({ filePath: "/a" })).toBe("/a");
    expect(aliasedPath({ file_path: "/b" })).toBe("/b");
    expect(aliasedPath({ file: "/c" })).toBe("/c");
  });

  it("returns undefined when nothing path-like is present", () => {
    expect(aliasedPath({ offset: 1 })).toBeUndefined();
    expect(aliasedPath(null)).toBeUndefined();
    expect(aliasedPath("x")).toBeUndefined();
  });
});
