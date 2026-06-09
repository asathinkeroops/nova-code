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
});
