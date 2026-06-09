import { describe, expect, it } from "vitest";
import { handleCommit } from "./commit.js";

describe("handleCommit", () => {
  it("returns a prompt that inspects the diff and commits in Conventional style", () => {
    const outcome = handleCommit("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("git diff");
    expect(outcome.text).toMatch(/Conventional Commits/i);
    expect(outcome.text).toMatch(/do NOT push/i);
  });

  it("studies recent commit history for language and style", () => {
    const outcome = handleCommit("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("git log -n 10");
    expect(outcome.text).toMatch(/match its language/i);
    expect(outcome.text).toMatch(/defer to the repo's own convention/i);
  });

  it("does not add attribution trailers unless asked", () => {
    const outcome = handleCommit("");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toMatch(/co-author or tool attribution/i);
  });

  it("passes args through as extra guidance", () => {
    const outcome = handleCommit("  only the parser changes  ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).toContain("Extra guidance from me: only the parser changes");
  });

  it("omits the guidance line when no args are given", () => {
    const outcome = handleCommit("   ");
    expect(outcome.kind).toBe("prompt");
    if (outcome.kind !== "prompt") return;
    expect(outcome.text).not.toContain("Extra guidance from me");
  });
});
