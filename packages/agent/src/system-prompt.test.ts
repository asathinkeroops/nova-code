import type { MemoryBundle } from "./memory.js";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

const emptyMemory: MemoryBundle = { system: "", sources: [] };

describe("buildSystemPrompt", () => {
  it("ends with the language guard naming the configured language", () => {
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1", language: "zh-CN" });
    expect(prompt.trimEnd()).toMatch(/respond in zh-CN[\s\S]*$/i);
  });

  it("defaults the configured language to English", () => {
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1" });
    expect(prompt.trimEnd()).toMatch(/respond in en[\s\S]*$/i);
  });

  it("reasserts the language guard AFTER injected memory", () => {
    // A memory file written in Chinese must not be the model's last-read
    // instruction — the language guard has to come after it.
    const memory: MemoryBundle = {
      system: '<memory layer="project" path="/ws/CLAUDE.md">请始终用中文回答</memory>',
      sources: [{ layer: "project", path: "/ws/CLAUDE.md", filename: "CLAUDE.md" }],
    };
    const prompt = buildSystemPrompt({ workspace: "/ws", memory, sessionId: "sess-1", language: "en" });

    const memoryIdx = prompt.indexOf("请始终用中文回答");
    const guardIdx = prompt.indexOf("respond in en");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(memoryIdx);
  });

  it("anchors the in-list language bullet on the configured language", () => {
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1", language: "fr" });
    expect(prompt).toContain("Respond in fr by default");
  });

  it("bakes in version-control guidance so committing needs no slash command", () => {
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1" });
    expect(prompt).toContain("Conventional Commits");
    expect(prompt).toMatch(/never push/i);
    expect(prompt).toMatch(/git log/);
  });

  it("injects today's date + weekday at day granularity so the model knows the current year", () => {
    // Without an injected date the model falls back to a training-era default
    // (e.g. answering 2026 weather queries with 2025). Day granularity keeps the
    // prompt stable within a day so it doesn't bust the prompt cache.
    const now = new Date();
    const date = now.toLocaleDateString("en-CA");
    const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1" });
    expect(prompt).toContain(`date="${date} (${weekday})"`);
    // No time-of-day component — that would change every request and defeat caching.
    expect(prompt).not.toMatch(/date="\d{4}-\d{2}-\d{2}T/);
  });

  it("emits memory-upkeep instructions when an auto memory dir is set", () => {
    const memory: MemoryBundle = { system: "", sources: [], autoDir: "/ws/.nova/memory" };
    const prompt = buildSystemPrompt({ workspace: "/ws", memory, sessionId: "sess-1" });
    expect(prompt).toContain("<memory-instructions>");
    expect(prompt).toContain("/ws/.nova/memory");
    expect(prompt).toContain("MEMORY.md");
  });

  it("omits memory-upkeep instructions when auto memory is disabled (no autoDir)", () => {
    const prompt = buildSystemPrompt({ workspace: "/ws", memory: emptyMemory, sessionId: "sess-1" });
    expect(prompt).not.toContain("<memory-instructions>");
  });

  it("keeps the language guard after the memory-upkeep instructions", () => {
    const memory: MemoryBundle = { system: "", sources: [], autoDir: "/ws/.nova/memory" };
    const prompt = buildSystemPrompt({ workspace: "/ws", memory, sessionId: "sess-1", language: "en" });
    expect(prompt.indexOf("respond in en")).toBeGreaterThan(prompt.indexOf("<memory-instructions>"));
  });

  it("injects the host's tool-guidance block", () => {
    const prompt = buildSystemPrompt({
      workspace: "/ws",
      memory: emptyMemory,
      sessionId: "sess-1",
      toolsGuidance: "<tool-guidance>\n- use the widget\n</tool-guidance>",
    });
    expect(prompt).toContain("- use the widget");
  });

  it("teaches no tool of its own — guidance arrives gated, or not at all", () => {
    // These bullets used to be hardcoded here and were emitted even when the
    // session had no such tool (sub-agents off, plan-mode tools off, a
    // permissions.deny entry). They now live in ToolPromptSections.
    const prompt = buildSystemPrompt({
      workspace: "/ws",
      memory: emptyMemory,
      sessionId: "sess-1",
    });
    for (const name of ["createTodo", "createTask", "createSubAgent", "loadSkill", "monitor"]) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).not.toContain("run_in_background");
  });

  it("does not name 'Chinese' anywhere — naming it primes a Chinese-prior model", () => {
    // The only language token that may appear is 'English' (in the langGuard,
    // as the positive example). 'Chinese' must not appear: Nova is tuned for
    // DeepSeek, and naming Chinese in the system prompt biased English prompts
    // toward Chinese replies.
    const prompt = buildSystemPrompt({
      workspace: "/ws",
      memory: { system: "<memory>plain english memory</memory>", sources: [] },
      sessionId: "sess-1",
    });
    expect(prompt).not.toContain("Chinese");
    expect(prompt).not.toMatch(/[一-鿿]/);
  });
});
