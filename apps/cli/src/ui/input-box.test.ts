import { describe, expect, it } from "vitest";
import { commandTokenRange, type SlashCommand } from "./input-box.js";

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
