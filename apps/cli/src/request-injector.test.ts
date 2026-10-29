import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { markSynthetic, type MessageParam, type ToolDefinition } from "@nova/core";
import { settingsSchema, type Logger, type Settings } from "@nova/base";
import { makePlanModeReminder } from "./plan-mode-reminder.js";
import { combinePreRequestInjectors, type PreRequestInjector } from "./request-injector.js";
import { createSkillsIndexProvider, makeSkillsIndexReminder } from "./skills-index.js";

const logger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
} as unknown as Logger;

const LOAD_SKILL: ToolDefinition = {
  name: "loadSkill",
  description: "",
  inputSchema: z.object({}),
};

const user = (text: string): MessageParam => ({ role: "user", content: text });

function payload(messages: MessageParam[]) {
  return { system: "", messages, tools: [LOAD_SKILL], maxTokens: 1024 };
}

function settings(): Settings {
  return settingsSchema.parse({ skills: { userPaths: [] } });
}

function workspaceWithSkill(): string {
  const ws = mkdtempSync(join(tmpdir(), "nova-request-injector-"));
  const dir = join(ws, ".nova", "skills", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill\n---\nBODY\n",
    "utf8",
  );
  return ws;
}

describe("combinePreRequestInjectors", () => {
  it("appends every injector's messages in order", async () => {
    const first: PreRequestInjector = ({ messages }) => ({
      messages: [...messages, markSynthetic(user("first"), "todo-reminder")],
    });
    const second: PreRequestInjector = ({ messages }) => ({
      messages: [...messages, markSynthetic(user("second"), "plan-mode")],
    });

    const result = await combinePreRequestInjectors([first, second])(payload([user("hi")]));

    expect(result?.messages?.map((m) => m.meta?.kind ?? "human")).toEqual([
      "human",
      "todo-reminder",
      "plan-mode",
    ]);
  });

  it("keeps going when an earlier injector has nothing to say", async () => {
    const silent: PreRequestInjector = () => undefined;
    const second: PreRequestInjector = ({ messages }) => ({
      messages: [...messages, markSynthetic(user("second"), "plan-mode")],
    });

    const result = await combinePreRequestInjectors([silent, second])(payload([user("hi")]));

    expect(result?.messages?.map((m) => m.meta?.kind ?? "human")).toEqual(["human", "plan-mode"]);
  });

  it("shows each injector the messages the previous ones appended", async () => {
    let sawFirst = false;
    const first: PreRequestInjector = ({ messages }) => ({
      messages: [...messages, markSynthetic(user("first"), "todo-reminder")],
    });
    const second: PreRequestInjector = ({ messages }) => {
      sawFirst = messages.some((m) => m.meta?.kind === "todo-reminder");
      return undefined;
    };

    await combinePreRequestInjectors([first, second])(payload([user("hi")]));

    expect(sawFirst).toBe(true);
  });

  it("returns undefined when nobody injects", async () => {
    const result = await combinePreRequestInjectors([() => undefined, () => undefined])(
      payload([user("hi")]),
    );
    expect(result).toBeUndefined();
  });

  it("rejects an injector that rewrites history instead of appending", async () => {
    const rewriting: PreRequestInjector = () => ({ messages: [user("replaced")] });

    await expect(combinePreRequestInjectors([rewriting])(payload([user("hi")]))).rejects.toThrow();
  });

  it("injects the skills index alongside a first-request plan-mode notice", async () => {
    const ws = workspaceWithSkill();
    try {
      const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
      const combine = combinePreRequestInjectors([
        makePlanModeReminder(() => "plan"),
        makeSkillsIndexReminder(provider),
      ]);

      const result = await combine(payload([user("hi")]));

      expect(result?.messages?.map((m) => m.meta?.kind ?? "human")).toEqual([
        "human",
        "plan-mode",
        "skills-index",
      ]);
      expect(result?.messages?.at(-1)?.meta).toMatchObject({
        kind: "skills-index",
        version: provider.current().version,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("injects the skills index alongside a monitor notification", async () => {
    const ws = workspaceWithSkill();
    try {
      const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
      const notification: PreRequestInjector = ({ messages }) => ({
        messages: [
          ...messages,
          markSynthetic(
            { role: "user", content: "<monitor-notification>build failed</monitor-notification>" },
            "monitor-notification",
          ),
        ],
      });
      const combine = combinePreRequestInjectors([notification, makeSkillsIndexReminder(provider)]);

      const result = await combine(payload([user("hi")]));

      expect(result?.messages?.map((m) => m.meta?.kind ?? "human")).toEqual([
        "human",
        "monitor-notification",
        "skills-index",
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
