import { describe, expect, it } from "vitest";
import { handleReview } from "./review.js";

describe("handleReview", () => {
  it("returns a prompt that reviews the diff without editing", () => {
    const outcome = handleReview("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("git diff");
    expect(outcome.text).toMatch(/do NOT edit/i);
  });

  it("uses a default focus when no args are given", () => {
    const outcome = handleReview("   ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("correctness and regressions in adjacent code");
  });

  it("threads a custom focus into the prompt", () => {
    const outcome = handleReview("security of the auth flow");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("focus on security of the auth flow");
  });

  it("asks for the review in the request's language", () => {
    const outcome = handleReview("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toMatch(/same language and script/i);
  });

  it("reviews a GitHub PR when given a bare number", () => {
    const outcome = handleReview("1234");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("pull request #1234");
    expect(outcome.text).toContain("gh pr diff 1234");
    expect(outcome.text).toMatch(/do NOT edit/i);
    expect(outcome.text).toMatch(/not post any comment/i);
  });

  it("accepts a #-prefixed PR number and a GitHub PR URL", () => {
    for (const arg of ["#88", "https://github.com/acme/repo/pull/88"]) {
      const outcome = handleReview(arg);
      expect(outcome.kind).toBe("prompt");
      if (outcome.kind !== "prompt") return;
      expect(outcome.text).toContain("gh pr view 88");
    }
  });

  it("threads a focus after the PR number", () => {
    const outcome = handleReview("1234 the auth flow");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("pull request #1234");
    expect(outcome.text).toContain("focus on the auth flow");
  });

  it("treats a non-numeric leading arg as a local-diff focus, not a PR", () => {
    const outcome = handleReview("security of the auth flow");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("uncommitted changes");
    expect(outcome.text).not.toContain("gh pr");
  });
});
