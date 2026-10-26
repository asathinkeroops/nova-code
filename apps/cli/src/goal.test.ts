import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@nova/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGoalEvalPrompt,
  clearGoal,
  digestMessages,
  loadGoal,
  parseVerdict,
  saveGoal,
  type GoalState,
} from "./goal.js";

describe("parseVerdict", () => {
  it("reads the VERDICT line", () => {
    expect(parseVerdict("VERDICT: MET\nall tests green").met).toBe(true);
    expect(parseVerdict("VERDICT: NOT_MET\nlint still fails").met).toBe(false);
    expect(parseVerdict("VERDICT: NOT MET").met).toBe(false);
  });

  it("keeps the reason after the verdict marker", () => {
    expect(parseVerdict("VERDICT: NOT_MET — 2 tests still fail").reason).toBe("2 tests still fail");
    expect(parseVerdict("VERDICT: MET\nthe build succeeded").reason).toBe("the build succeeded");
  });

  it("finds the verdict even when prose precedes it", () => {
    const v = parseVerdict("I ran the suite and everything is green.\nVERDICT: MET\nall good");
    expect(v.met).toBe(true);
    expect(v.reason).toBe("all good");
  });

  it("does not treat a bare MET / NOT_MET word as a verdict", () => {
    expect(parseVerdict("looks NOT_MET to me").met).toBe(false);
    expect(parseVerdict("seems MET").met).toBe(false);
  });

  it("keeps ambiguous prose NOT met", () => {
    expect(parseVerdict("I cannot determine whether the goal is met.").met).toBe(false);
    expect(parseVerdict("The goal is not yet met.").met).toBe(false);
    expect(parseVerdict("It isn't met yet; the tests fail.").met).toBe(false);
    expect(parseVerdict("The goal may have been met.").met).toBe(false);
  });

  it("ignores quoted format examples and prose mentions", () => {
    expect(
      parseVerdict(
        "Example format: VERDICT: MET\nActual verdict: VERDICT: NOT_MET\nTests still fail.",
      ).met,
    ).toBe(false);
    expect(parseVerdict("You must end with VERDICT: MET or VERDICT: NOT_MET.").met).toBe(false);
    // Four leading spaces are a code block, not a verdict line.
    expect(parseVerdict("    VERDICT: MET\nnot actually done").met).toBe(false);
  });

  it("treats conflicting verdict lines as NOT met", () => {
    const v = parseVerdict("VERDICT: MET\nall green\nVERDICT: NOT_MET\ntests fail");
    expect(v.met).toBe(false);
    expect(v.reason).toContain("conflicting");
  });

  it("accepts a verdict line with markdown decoration", () => {
    expect(parseVerdict("**VERDICT: MET**\nall green").met).toBe(true);
    expect(parseVerdict("> **VERDICT: MET**\nall green").met).toBe(true);
    expect(parseVerdict("> VERDICT: NOT_MET\ntests fail").met).toBe(false);
  });

  it("defaults to NOT met when there is no clear verdict", () => {
    expect(parseVerdict("hmm unsure").met).toBe(false);
  });
});

describe("buildGoalEvalPrompt", () => {
  it("embeds the condition and a conversation digest", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run the tests" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "2 passed, 0 failed" }],
      },
    ];
    const prompt = buildGoalEvalPrompt("the build passes", messages);
    expect(prompt).toContain("the build passes");
    expect(prompt).toContain("2 passed, 0 failed");
    expect(prompt).toContain("VERDICT");
  });
});

describe("digestMessages", () => {
  it("includes tool results and tool calls as evidence", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "run the tests" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "pnpm test" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "2 passed, 0 failed" }],
      },
    ];
    const digest = digestMessages(messages);
    expect(digest).toContain("run the tests");
    expect(digest).toContain("[tool bash]");
    expect(digest).toContain("2 passed, 0 failed");
  });

  it("flags error results", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
      },
    ];
    expect(digestMessages(messages)).toContain("tool result ERROR");
  });
});

describe("goal persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-goal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a goal through disk", async () => {
    const state: GoalState = { condition: "tests pass", setAt: 123, continuations: 2 };
    await saveGoal(dir, state);
    expect(await readFile(join(dir, "goal.json"), "utf8")).toContain("tests pass");
    expect(await loadGoal(dir)).toEqual(state);
  });

  it("returns null when no goal is stored", async () => {
    expect(await loadGoal(dir)).toBeNull();
  });

  it("returns null for malformed json", async () => {
    await writeFile(join(dir, "goal.json"), "{ not json", "utf8");
    expect(await loadGoal(dir)).toBeNull();
  });

  it("clearGoal removes the file and is a no-op when absent", async () => {
    await saveGoal(dir, { condition: "x", setAt: 1, continuations: 0 });
    await clearGoal(dir);
    expect(await loadGoal(dir)).toBeNull();
    await expect(clearGoal(dir)).resolves.toBeUndefined();
  });
});
