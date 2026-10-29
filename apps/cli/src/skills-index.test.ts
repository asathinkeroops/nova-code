import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { markSynthetic, type MessageParam, type ToolDefinition } from "@nova/core";
import { loadMessages } from "@nova/agent";
import { settingsSchema, type Logger, type Settings } from "@nova/base";
import {
  createSkillsIndexProvider,
  makeSkillsIndexReminder,
  skillsIndexMessageText,
} from "./skills-index.js";

const logger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
} as unknown as Logger;

function settings(overrides: Record<string, unknown> = {}): Settings {
  // Empty userPaths pins the scan to the temp workspace; otherwise the real
  // ~/.nova/skills leaks into the fixture.
  return settingsSchema.parse({ skills: { userPaths: [], ...overrides } });
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "nova-skills-index-"));
}

function writeSkill(ws: string, name: string, description: string, extraFrontMatter = ""): void {
  const dir = join(ws, ".nova", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontMatter}---\nBODY\n`,
    "utf8",
  );
}

const tool = (name: string): ToolDefinition => ({
  name,
  description: "",
  inputSchema: z.object({}),
});

const LOAD_SKILL = tool("loadSkill");

function user(text: string): MessageParam {
  return { role: "user", content: text };
}

function assistant(text: string): MessageParam {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * A pre-migration session: old JSONL records with no `formatVersion` and no
 * `meta`, exactly what `loadMessages` sees when `/resume` opens a session
 * written before the index became a message.
 */
async function loadLegacyHistory(ws: string): Promise<MessageParam[]> {
  const path = join(ws, "messages.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ role: "user", content: "old question" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return loadMessages(path);
}

function payload(messages: MessageParam[], tools: ToolDefinition[] = [LOAD_SKILL]) {
  return { system: "", messages, tools, maxTokens: 1024 };
}

describe("createSkillsIndexProvider", () => {
  it("exposes the scanned list and a versioned snapshot", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha skill");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });

    expect(provider.enabled).toBe(true);
    expect(provider.list().map((s) => s.name)).toEqual(["alpha"]);
    expect(provider.current().text).toContain("- alpha: Alpha skill");
    expect(provider.current().version).not.toBe("empty");
  });

  it("keeps the snapshot stable until refresh, then picks up changes", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha skill");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const firstVersion = provider.current().version;

    writeSkill(ws, "beta", "Beta skill");
    expect(provider.list().map((s) => s.name)).toEqual(["alpha"]);

    provider.refresh();
    expect(
      provider
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(provider.current().version).not.toBe(firstVersion);
    expect(provider.current().text).toContain("- beta: Beta skill");
  });

  it("withholds disable-model-invocation skills from the index but keeps them in /skills", () => {
    const ws = workspace();
    writeSkill(ws, "visible", "Visible");
    writeSkill(ws, "hidden", "Hidden", "disable-model-invocation: true\n");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });

    expect(
      provider
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["hidden", "visible"]);
    expect(provider.current().text).toContain("visible");
    expect(provider.current().text).not.toContain("hidden");
  });

  it("is disabled when settings.skills.enabled is false", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({
      settings: settings({ enabled: false }),
      workspace: ws,
      logger,
    });

    expect(provider.enabled).toBe(false);
    expect(provider.current().text).toBe("");
    expect(provider.refresh().text).toBe("");
  });
});

describe("makeSkillsIndexReminder", () => {
  it("injects the index after the first user message", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha skill");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    const result = hook(payload([user("hi")]));
    expect(result?.messages).toHaveLength(2);
    const injected = result!.messages![1]!;
    expect(injected.role).toBe("user");
    expect(injected.meta).toEqual({
      synthetic: true,
      kind: "skills-index",
      version: provider.current().version,
    });
    expect(skillsIndexMessageText(injected)).toContain("<available-skills>");
    expect(skillsIndexMessageText(injected)).toContain("- alpha: Alpha skill");
  });

  it("injects into a resumed legacy history that predates skills-index", async () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha skill");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const legacy = await loadLegacyHistory(ws);

    expect(legacy.some((message) => message.meta?.kind === "skills-index")).toBe(false);
    const result = makeSkillsIndexReminder(provider)(payload(legacy));
    const injected = result?.messages?.at(-1);

    expect(injected?.meta).toEqual({
      synthetic: true,
      kind: "skills-index",
      version: provider.current().version,
    });
    const text = skillsIndexMessageText(injected!);
    expect(text).toContain("- alpha: Alpha skill");
    // First injection, not an update: the legacy history never had an index.
    expect(text).not.toContain("skills has changed");
  });

  it("does not inject twice into the same resumed legacy history", async () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    const once = hook(payload(await loadLegacyHistory(ws)));
    expect(once).toBeDefined();
    expect(hook(payload(once!.messages!))).toBeUndefined();
  });

  it("does not re-inject when the visible version matches", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    const once = hook(payload([user("hi")]))!;
    expect(hook(payload(once.messages!))).toBeUndefined();
  });

  it("injects the changed form when refresh changes the list", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);
    const once = hook(payload([user("hi")]))!;

    writeSkill(ws, "beta", "Beta");
    provider.refresh();
    const second = hook(payload(once.messages!))!;
    const text = skillsIndexMessageText(second.messages!.at(-1)!);
    expect(text).toContain("skills has changed");
    expect(text).toContain("- beta: Beta");
  });

  it("stops injecting when loadSkill is not in the live tool set", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    expect(hook(payload([user("hi")], []))).toBeUndefined();
    expect(hook(payload([user("hi")], [tool("read")]))).toBeUndefined();
  });

  it("does not open a session with an empty index", () => {
    const ws = workspace();
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    expect(provider.current().text).toContain("no skills are currently available");
    expect(makeSkillsIndexReminder(provider)(payload([user("hi")]))).toBeUndefined();
  });

  it("does not inject into a legacy history when the index is empty or disabled", () => {
    const emptyWs = workspace();
    const empty = createSkillsIndexProvider({ settings: settings(), workspace: emptyWs, logger });
    expect(
      makeSkillsIndexReminder(empty)(payload([user("old"), assistant("old")])),
    ).toBeUndefined();

    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const disabled = createSkillsIndexProvider({
      settings: settings({ enabled: false }),
      workspace: ws,
      logger,
    });
    expect(
      makeSkillsIndexReminder(disabled)(payload([user("old"), assistant("old")])),
    ).toBeUndefined();
  });

  it("announces a transition from skills to none", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);
    const once = hook(payload([user("hi")]))!;

    rmSync(join(ws, ".nova", "skills", "alpha"), { recursive: true });
    provider.refresh();
    const second = hook(payload(once.messages!))!;
    expect(skillsIndexMessageText(second.messages!.at(-1)!)).toContain(
      "no skills are currently available",
    );
  });

  it("re-injects after a compaction boundary hides the old index", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    const oldIndex = markSynthetic(
      { role: "user", content: provider.current().text },
      "skills-index",
      provider.current().version,
    );
    const boundary = markSynthetic(
      { role: "user", content: "<compacted>\nsummary\n</compacted>" },
      "compacted",
    );

    // The old index sits before the boundary, so the model cannot see it.
    expect(hook(payload([oldIndex, boundary, user("hi")]))).toBeDefined();
  });

  it("injects after a compaction boundary in a legacy history without an index", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const boundary = markSynthetic(
      { role: "user", content: "<compacted>\nsummary\n</compacted>" },
      "compacted",
    );

    const result = makeSkillsIndexReminder(provider)(
      payload([user("old"), boundary, user("next")]),
    );
    expect(result?.messages?.at(-1)?.meta).toMatchObject({ kind: "skills-index" });
  });

  it("re-injects when a persisted index predates meta.version", () => {
    const ws = workspace();
    writeSkill(ws, "alpha", "Alpha");
    const provider = createSkillsIndexProvider({ settings: settings(), workspace: ws, logger });
    const hook = makeSkillsIndexReminder(provider);

    const legacy = markSynthetic(
      { role: "user", content: provider.current().text },
      "skills-index",
    );
    expect(hook(payload([legacy, user("hi")]))).toBeDefined();
  });
});
