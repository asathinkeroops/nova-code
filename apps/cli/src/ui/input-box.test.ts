import { describe, expect, it } from "vitest";
import {
  commandTokenRange,
  historyRule,
  matchingFiles,
  mentionTokenAt,
  sessionNameBadge,
  type SlashCommand,
} from "./input-box.js";

const cmds: SlashCommand[] = [
  { name: "/agent", description: "delegate a task to a named sub-agent" },
  { name: "/agents", description: "list available sub-agent types" },
  { name: "/help", description: "show this help" },
  { name: "/compact", description: "summarize history" },
];

describe("commandTokenRange", () => {
  it("returns null when the buffer is not a slash command", () => {
    expect(commandTokenRange("", cmds)).toBeNull();
    expect(commandTokenRange("hello world", cmds)).toBeNull();
  });

  it("returns null for a bare slash (nothing typed yet)", () => {
    expect(commandTokenRange("/", cmds)).toBeNull();
  });

  it("highlights a prefix that matches at least one command", () => {
    expect(commandTokenRange("/h", cmds)).toEqual([0, 2]);
    expect(commandTokenRange("/co", cmds)).toEqual([0, 3]);
    // /ag is a prefix of both /agent and /agents — still one contiguous token
    expect(commandTokenRange("/ag", cmds)).toEqual([0, 3]);
  });

  it("highlights a fully-typed command name", () => {
    expect(commandTokenRange("/help", cmds)).toEqual([0, 5]);
    expect(commandTokenRange("/agent", cmds)).toEqual([0, 6]);
    expect(commandTokenRange("/agents", cmds)).toEqual([0, 7]);
  });

  it("highlights only the command token, not its arguments", () => {
    expect(commandTokenRange("/agent trace foo", cmds)).toEqual([0, 6]);
    expect(commandTokenRange("/compact   keep tests", cmds)).toEqual([0, 8]);
  });

  it("returns null for a typo or a non-command slash path", () => {
    expect(commandTokenRange("/agentt foo", cmds)).toBeNull();
    expect(commandTokenRange("/usr/bin", cmds)).toBeNull();
    expect(commandTokenRange("/nope", cmds)).toBeNull();
  });

  it("returns null when no commands are registered", () => {
    expect(commandTokenRange("/help", [])).toBeNull();
  });

  it("is case-insensitive and works with names lacking a leading slash", () => {
    expect(commandTokenRange("/HE", cmds)).toEqual([0, 3]);
    expect(commandTokenRange("/he", [{ name: "help", description: "" }])).toEqual([0, 3]);
  });
});

describe("mentionTokenAt", () => {
  it("returns null when the cursor is not in an @token", () => {
    expect(mentionTokenAt("", 0)).toBeNull();
    expect(mentionTokenAt("hello", 5)).toBeNull();
    expect(mentionTokenAt("hello world", 11)).toBeNull();
  });

  it("detects a bare @ at the buffer start", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("detects an @token mid-buffer preceded by whitespace", () => {
    const buf = "look at @src/foo";
    expect(mentionTokenAt(buf, buf.length)).toEqual({ start: 8, end: 16, query: "src/foo" });
  });

  it("requires the @ to start a word (not mid-word like an email)", () => {
    const buf = "mail me a@b.com";
    expect(mentionTokenAt(buf, buf.length)).toBeNull();
  });

  it("clips the query at the cursor but spans the whole word in end", () => {
    // cursor after "src" while "src/foo.ts" is the full token under it
    const buf = "@src/foo.ts";
    expect(mentionTokenAt(buf, 4)).toEqual({ start: 0, end: 11, query: "src" });
  });

  it("never fires on a slash command line", () => {
    const buf = "/agent @foo";
    expect(mentionTokenAt(buf, buf.length)).toBeNull();
  });
});

describe("sessionNameBadge", () => {
  it("returns null for an empty or whitespace-only name", () => {
    expect(sessionNameBadge("", 80)).toBeNull();
    expect(sessionNameBadge("   ", 80)).toBeNull();
  });

  it("pads the name and leaves a trailing rule so it isn't flush-right", () => {
    const out = sessionNameBadge("api work", 40);
    expect(out).not.toBeNull();
    expect(out!.badge).toBe(" api work ");
    // lead + badge + trail spans exactly `width` columns
    expect(out!.lead.length + out!.badge.length + out!.trail.length).toBe(40);
    // a few rule chars sit to the right of the badge
    expect(out!.trail.length).toBe(3);
    expect(out!.lead.length).toBe(27);
  });

  it("trims surrounding whitespace before badging", () => {
    expect(sessionNameBadge("  hi  ", 40)?.badge).toBe(" hi ");
  });

  it("truncates a name too long for the frame, keeping one lead rule char", () => {
    const out = sessionNameBadge("a".repeat(100), 20);
    expect(out).not.toBeNull();
    expect(out!.lead.length).toBeGreaterThanOrEqual(1);
    expect(out!.lead.length + out!.badge.length + out!.trail.length).toBe(20);
  });
});

describe("historyRule", () => {
  it("embeds the position label and fills exactly `width` columns", () => {
    const out = historyRule(40, 2, 7);
    expect(out).toContain(" History 2/7 ");
    expect(out.length).toBe(40);
  });

  it("coexists with the session-name badge: label fills the badge's lead width", () => {
    const badge = sessionNameBadge("api work", 60)!;
    const left = historyRule(badge.lead.length, 3, 9);
    // left + badge + trail still spans the full frame width
    expect(left.length + badge.badge.length + badge.trail.length).toBe(60);
    expect(left).toContain(" History 3/9 ");
  });
});

describe("matchingFiles", () => {
  const files = [
    "src/config.ts",
    "src/ui/input-box.tsx",
    "packages/runtime/src/config.ts",
    "README.md",
  ];

  it("ranks basename-prefix matches above substring matches", () => {
    const out = matchingFiles("config", files, 10);
    // both config.ts files match on basename prefix; the shorter path wins ties
    expect(out[0]).toBe("src/config.ts");
    expect(out).toContain("packages/runtime/src/config.ts");
  });

  it("matches on a path substring when the basename does not", () => {
    expect(matchingFiles("runtime", files, 10)).toEqual(["packages/runtime/src/config.ts"]);
  });

  it("is case-insensitive", () => {
    expect(matchingFiles("readme", files, 10)).toEqual(["README.md"]);
  });

  it("excludes non-matches", () => {
    expect(matchingFiles("nope", files, 10)).toEqual([]);
  });

  it("returns the shortest paths first for an empty query", () => {
    expect(matchingFiles("", files, 2)).toEqual(["README.md", "src/config.ts"]);
  });

  it("honors the limit", () => {
    expect(matchingFiles("", files, 1)).toHaveLength(1);
  });
});
