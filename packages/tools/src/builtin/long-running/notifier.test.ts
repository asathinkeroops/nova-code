import { describe, expect, it } from "vitest";
import type { MessageParam, ToolDefinition } from "@nova/core";
import { LongRunningCommandManager } from "./manager.js";
import { makeLongRunningNotifier } from "./notifier.js";

const tools: ToolDefinition[] = [];

function basePayload(messages: MessageParam[]): {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
} {
  return { system: "", messages, tools, maxTokens: 1024 };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("makeLongRunningNotifier", () => {
  it("returns undefined when the queue is empty", async () => {
    const mgr = new LongRunningCommandManager();
    const hook = makeLongRunningNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    expect(out).toBeUndefined();
  });

  it("appends a user message rendering each drained command and drains the queue", async () => {
    const mgr = new LongRunningCommandManager();
    const { id: a } = mgr.start({ command: "echo aa", cwd: process.cwd() });
    const { id: b } = mgr.start({ command: "exit 5", cwd: process.cwd() });
    await waitFor(
      () => mgr.get(a)?.status !== "running" && mgr.get(b)?.status !== "running",
    );

    const hook = makeLongRunningNotifier(mgr);
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];
    const out = await hook(basePayload(messages));

    expect(out?.messages).toBeDefined();
    expect(out!.messages!.length).toBe(messages.length + 1);

    const injected = out!.messages![messages.length]!;
    expect(injected.role).toBe("user");
    const blocks = injected.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    const text = blocks[0]!.text;
    expect(text).toContain(`id="${a}"`);
    expect(text).toContain(`id="${b}"`);
    expect(text).toContain('status="completed"');
    expect(text).toContain('status="error"');
    expect(text).toContain("aa");
    expect(text).toContain("exited with code 5");

    // queue drained
    const second = await hook(basePayload(messages));
    expect(second).toBeUndefined();
  });
});
