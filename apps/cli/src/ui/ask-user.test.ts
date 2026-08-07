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
    // Pins the chrome term: top rule 1 + marginY 2 = 3, the same overlay chrome
    // pickListRows reserves. The panel and this estimate have to agree or the
    // message region paints over it, and nothing else would catch a border (or
    // padding) being added back: at 200 columns the body is a fixed 10 rows —
    // question + tab strip + blank + 3 options + freeform input + hint.
    expect(askRows(req({}), 200)).toBe(13);
  });

  it("reserves fewer rows when freeform is disabled (no auto 'Other' option)", () => {
    const withOther = askRows(req({ allowFreeform: true }), 80);
    const without = askRows(req({ allowFreeform: false }), 80);
    expect(without).toBeLessThan(withOther);
  });
});
