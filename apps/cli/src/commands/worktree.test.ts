import { describe, expect, it } from "vitest";
import { parseNewWorktreeArgs } from "./worktree.js";

describe("parseNewWorktreeArgs", () => {
  it("accepts a bare name", () => {
    expect(parseNewWorktreeArgs(["feat"])).toEqual({ name: "feat" });
  });

  it("accepts `from <ref>`", () => {
    expect(parseNewWorktreeArgs(["feat", "from", "HEAD"])).toEqual({
      name: "feat",
      from: "HEAD",
    });
    expect(parseNewWorktreeArgs(["feat", "from", "origin/main"])).toEqual({
      name: "feat",
      from: "origin/main",
    });
  });

  it("treats a ref literally named `from` as the ref, not the keyword", () => {
    expect(parseNewWorktreeArgs(["feat", "from", "from"])).toEqual({ name: "feat", from: "from" });
  });

  it("rejects a missing ref", () => {
    expect(parseNewWorktreeArgs(["feat", "from"])).toBeUndefined();
  });

  it("rejects extra arguments", () => {
    expect(parseNewWorktreeArgs(["feat", "from", "HEAD", "extra"])).toBeUndefined();
    expect(parseNewWorktreeArgs(["feat", "HEAD"])).toBeUndefined();
  });

  it("rejects an empty invocation", () => {
    expect(parseNewWorktreeArgs([])).toBeUndefined();
  });
});
