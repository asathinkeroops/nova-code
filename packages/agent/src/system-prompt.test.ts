import type { MemoryBundle } from "@nova/context";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

const emptyMemory: MemoryBundle = { system: "", sources: [] };

describe("buildSystemPrompt", () => {
  it("ends with the language guard when there is no memory", () => {
    const prompt = buildSystemPrompt("/ws", emptyMemory, "sess-1");
    expect(prompt.trimEnd()).toMatch(
      /respond in the language the user's latest message is written in[\s\S]*$/i,
    );
  });

  it("reasserts the language guard AFTER injected memory", () => {
    // A memory file written in Chinese must not be the model's last-read
    // instruction — the language guard has to come after it.
    const memory: MemoryBundle = {
      system: '<memory layer="project" path="/ws/CLAUDE.md">请始终用中文回答</memory>',
      sources: [{ layer: "project", path: "/ws/CLAUDE.md", filename: "CLAUDE.md" }],
    };
    const prompt = buildSystemPrompt("/ws", memory, "sess-1");

    const memoryIdx = prompt.indexOf("请始终用中文回答");
    const guardIdx = prompt.indexOf("respond in the language the user's latest message");
    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(memoryIdx);
  });

  it("keeps an in-list language-matching bullet", () => {
    const prompt = buildSystemPrompt("/ws", emptyMemory, "sess-1");
    expect(prompt).toContain("Respond in the same language and script as the user");
  });

  it("does not name 'Chinese' anywhere — naming it primes a Chinese-prior model", () => {
    // The only language token that may appear is 'English' (in the langGuard,
    // as the positive example). 'Chinese' must not appear: Nova is tuned for
    // DeepSeek, and naming Chinese in the system prompt biased English prompts
    // toward Chinese replies.
    const prompt = buildSystemPrompt(
      "/ws",
      { system: "<memory>plain english memory</memory>", sources: [] },
      "sess-1",
    );
    expect(prompt).not.toContain("Chinese");
    expect(prompt).not.toMatch(/[一-鿿]/);
  });
});
