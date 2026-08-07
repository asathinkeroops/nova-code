import { describe, expect, it } from "vitest";
import type { AskUserRequest } from "@nova/core";
import { askRows } from "./ask-user.js";

const req = (over: Partial<AskUserRequest["questions"][number]>): AskUserRequest => ({
  questions: [
    {
      question: "Proceed?",
      header: "Confirm",
      options: [
        { label: "Yes", description: "do it" },
        { label: "No", description: "skip" },
      ],
      multiSelect: false,
      ...over,
    },
  ],
});

describe("askRows", () => {
  it("reserves more rows for a tall multi-line question than a short one", () => {
    const short = askRows(req({ question: "Proceed?" }), 80);
    const tall = askRows(
      req({
        question:
          "The command was blocked by the OS sandbox:\n\n" +
          "echo '#!/bin/sh' > .git/hooks/post-commit\n\n" +
          "Sandbox denials:\n" +
          "bash(56125) deny(1) file-write-create /Users/x/repo/.git/hooks/post-commit\n\n" +
          "Re-run this command OUTSIDE the sandbox?",
      }),
      80,
    );
    expect(tall).toBeGreaterThan(short);
    // Regression guard: the old hardcoded estimate returned 10 and the message
    // region painted over the taller modal.
    expect(tall).toBeGreaterThan(10);
  });

  it("counts the same question as taller in a narrower terminal (wrapping)", () => {
    const q = req({ question: "x".repeat(120) });
    expect(askRows(q, 40)).toBeGreaterThan(askRows(q, 200));
  });

  it("reserves exactly the chrome the panel draws", () => {
    // Pins the chrome term: round border 2 + marginY 2 + the hint line below
    // the box 1 = 5. The panel and this estimate have to agree or the message
    // region paints over it, and nothing else would catch the border (or
    // padding) changing: at 200 columns the body is a fixed 12 rows — tab strip
    // + blank + question + blank + 3 options each with a description + the
    // freeform input.
    expect(askRows(req({}), 200)).toBe(17);
  });

  it("reserves the confirm tab's answer summary", () => {
    const short = {
      question: "Proceed?",
      header: "H",
      options: [{ label: "Yes" }, { label: "No" }],
      multiSelect: false,
    };
    const rows = (n: number): number =>
      askRows({ questions: Array.from({ length: n }, () => short) }, 200);
    // Questions this short are dwarfed by the confirm tab, whose summary lists
    // one row per question — so each extra question costs exactly one row.
    expect(rows(8) - rows(4)).toBe(4);
  });

  it("reserves the extra rows a wrapping tab strip takes", () => {
    const long = (n: number): AskUserRequest["questions"][number] => ({
      ...req({}).questions[0]!,
      header: `Header ${"x".repeat(n)}`,
    });
    const wide: AskUserRequest = { questions: [long(30), long(30), long(30)] };
    expect(askRows(wide, 60)).toBeGreaterThan(askRows(wide, 200));
  });

  it("reserves fewer rows when freeform is disabled (no auto 'Other' option)", () => {
    const withOther = askRows(req({ allowFreeform: true }), 80);
    const without = askRows(req({ allowFreeform: false }), 80);
    expect(without).toBeLessThan(withOther);
  });
});
