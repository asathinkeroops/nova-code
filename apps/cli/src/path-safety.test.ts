import { describe, expect, it } from "vitest";
import { PATH_INPUT_TOOLS } from "./path-safety.js";

// canonicalizePath / canonicalizeRoots behavior (`..` folding, symlink
// resolution, nearest-ancestor for write targets) is covered in
// @nova/base's path-safety.test.ts, where the shared logic now lives.
describe("PATH_INPUT_TOOLS", () => {
  it("lists the path-bearing builtins gated before a permission decision", () => {
    // read/write/edit touch the file; glob/grep use `path` as the search root.
    expect([...PATH_INPUT_TOOLS].sort()).toEqual(["edit", "glob", "grep", "read", "write"]);
  });
});
