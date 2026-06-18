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

  it("does not re-push output already consumed via read()", async () => {
    const mgr = new LongRunningCommandManager();
    // Output ("42") is computed, so it appears nowhere in the command string —
    // letting us assert it is absent from the completion push.
    const { id } = mgr.start({ command: "echo $((6 * 7))", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    // The model already streamed the output via getBackgroundOutput.
    expect(mgr.read(id).output).toContain("42");

    const hook = makeLongRunningNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    const blocks = out!.messages![1]!.content as Array<{ text: string }>;
    const text = blocks[0]!.text;
    expect(text).toContain('status="completed"');
    expect(text).not.toContain("42");
    expect(text).toContain("[no new output]");
  });

  it("still pushes the unread tail and exit marker on completion", async () => {
    const mgr = new LongRunningCommandManager();
    const { id } = mgr.start({
      command: "echo first; echo second; exit 2",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.get(id)?.status !== "running");

    // Read only enough to consume some, then completion delivers the rest.
    // (Here we read nothing first, so the full tail plus the marker arrive.)
    const hook = makeLongRunningNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    const blocks = out!.messages![1]!.content as Array<{ text: string }>;
    const text = blocks[0]!.text;
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("exited with code 2");
  });
});
