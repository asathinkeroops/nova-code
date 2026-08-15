import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MessageParam, ToolDefinition } from "@nova/core";
import { BackgroundCommandManager } from "./manager.js";
import { makeBackgroundNotifier } from "./notifier.js";

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

/**
 * Blank out the notice's two random components before asserting that a
 * command's output was NOT inlined.
 *
 * Both leak digits into the text: the command id is `randomBytes(6)` as
 * base64url, and the temp dir carries `mkdtemp`'s random suffix — and both are
 * echoed back in the notice (as `id="…"` and in the log path). A bare
 * `not.toContain("42")` therefore fails whenever either happens to contain
 * those two characters, which is ~0.34% of runs. Scrubbing them asserts what
 * the test actually means: the output itself never made it into the notice.
 */
function withoutRandomParts(text: string, dir: string, id: string): string {
  return text.split(dir).join("").split(id).join("");
}

describe("makeBackgroundNotifier", () => {
  it("returns undefined when the queue is empty", async () => {
    const mgr = new BackgroundCommandManager();
    const hook = makeBackgroundNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    expect(out).toBeUndefined();
  });

  it("appends a user message rendering each drained command and drains the queue", async () => {
    const mgr = new BackgroundCommandManager({ outputDir: mkdtempSync(join(tmpdir(), "nova-n-")) });
    const { id: a } = mgr.start({ command: "echo aa", cwd: process.cwd() });
    const { id: b } = mgr.start({ command: "exit 5", cwd: process.cwd() });
    await waitFor(() => mgr.get(a)?.status !== "running" && mgr.get(b)?.status !== "running");

    const hook = makeBackgroundNotifier(mgr);
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
    // The notice announces; it does not deliver — it points at each log file.
    expect(text).toContain(`${a}.log`);
    expect(text).toContain(`${b}.log`);
    expect(text).toContain("exited with code 5");

    // queue drained
    const second = await hook(basePayload(messages));
    expect(second).toBeUndefined();
  });

  it("never inlines output the model may already have read from the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-n-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });
    // Output ("42") is computed, so it appears nowhere in the command string —
    // letting us assert it is absent from the notice regardless of any read.
    const { id } = mgr.start({ command: "echo $((6 * 7))", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const logPath = join(dir, `${id}.log`);
    // Whether or not the model read the log, the notice looks the same — which
    // is the point: one channel, so there is nothing to de-duplicate.
    expect(readFileSync(logPath, "utf8")).toContain("42");

    const hook = makeBackgroundNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    const blocks = out!.messages![1]!.content as Array<{ text: string }>;
    const text = blocks[0]!.text;
    expect(text).toContain('status="completed"');
    expect(withoutRandomParts(text, dir, id)).not.toContain("42");
    expect(text).toContain(logPath);
  });

  it("announces the exit marker and the log path on a failed command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-n-"));
    const mgr = new BackgroundCommandManager({ outputDir: dir });
    // Computed output, so it appears nowhere in the echoed `command=` attribute.
    const { id } = mgr.start({ command: "echo $((20 + 22)); exit 2", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const hook = makeBackgroundNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    const blocks = out!.messages![1]!.content as Array<{ text: string }>;
    const text = blocks[0]!.text;
    expect(text).toContain("exited with code 2");
    expect(text).toContain(join(dir, `${id}.log`));
    // The output stayed in the file.
    expect(withoutRandomParts(text, dir, id)).not.toContain("42");
    expect(readFileSync(join(dir, `${id}.log`), "utf8")).toContain("42");
  });

  it("falls back to inlining when no outputDir is configured (single channel)", async () => {
    const mgr = new BackgroundCommandManager();
    const { id } = mgr.start({ command: "echo $((6 * 7))", cwd: process.cwd() });
    await waitFor(() => mgr.get(id)?.status !== "running");

    const hook = makeBackgroundNotifier(mgr);
    const out = await hook(basePayload([{ role: "user", content: "hi" }]));
    const blocks = out!.messages![1]!.content as Array<{ text: string }>;
    expect(blocks[0]!.text).toContain("42");
  });
});
