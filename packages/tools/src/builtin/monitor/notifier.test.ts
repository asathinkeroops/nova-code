import { describe, expect, it } from "vitest";
import type { MessageParam, ToolDefinition } from "@nova/core";
import { MonitorManager } from "./manager.js";
import { makeMonitorNotifier } from "./notifier.js";

const tools: ToolDefinition[] = [];

function basePayload(messages: MessageParam[]): {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
} {
  return { system: "", messages, tools, maxTokens: 1024 };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function start(mgr: MonitorManager, command: string, description = "test watch") {
  return mgr.start({
    command,
    description,
    cwd: process.cwd(),
    persistent: false,
    timeoutMs: 30_000,
  });
}

/** Text of the message the hook injected, or undefined when it injected none. */
async function inject(mgr: MonitorManager): Promise<string | undefined> {
  const hook = makeMonitorNotifier(mgr);
  const out = await hook(basePayload([{ role: "user", content: "hi" }]));
  if (!out?.messages) return undefined;
  const blocks = out.messages[1]!.content as Array<{ text: string }>;
  return blocks[0]!.text;
}

describe("makeMonitorNotifier", () => {
  it("returns undefined when nothing has fired", async () => {
    expect(await inject(new MonitorManager())).toBeUndefined();
  });

  it("inlines the event lines and labels them with the description", async () => {
    const mgr = new MonitorManager();
    const { id } = start(mgr, "printf 'ERROR one\\nERROR two\\n'", "errors in app.log");
    await waitFor(() => mgr.hasPending());

    const text = await inject(mgr);
    expect(text).toContain(`id="${id}"`);
    expect(text).toContain('watching="errors in app.log"');
    // Events ARE inlined — unlike a background command's output there is no
    // file the model could read them from instead.
    expect(text).toContain("ERROR one");
    expect(text).toContain("ERROR two");
  });

  it("drains, so the same event is never injected twice", async () => {
    const mgr = new MonitorManager();
    start(mgr, "echo only-once");
    await waitFor(() => mgr.hasPending());

    expect(await inject(mgr)).toContain("only-once");
    expect(await inject(mgr)).toBeUndefined();
  });

  it("announces a terminal transition so silence is never ambiguous", async () => {
    const mgr = new MonitorManager();
    const { id } = start(mgr, "echo tick; exit 3");
    await waitFor(() => mgr.get(id)?.status === "exited");

    const text = await inject(mgr);
    expect(text).toContain('status="exited"');
    expect(text).toContain("[monitor exited: script exited with code 3]");
  });

  it("reports dropped events rather than silently losing them", async () => {
    const mgr = new MonitorManager({ maxQueuedEvents: 2, maxEventsPerWindow: 1000 });
    const { id } = start(mgr, "for i in 1 2 3 4 5; do echo line-$i; done");
    await waitFor(() => mgr.get(id)?.status === "exited");

    const text = await inject(mgr);
    expect(text).toContain("dropped 3 older events");
    expect(text).toContain("line-5");
  });

  it("reports a flood kill in-band, so the model learns the watch is over", async () => {
    const mgr = new MonitorManager({ maxEventsPerWindow: 3, windowMs: 60_000 });
    const { id } = start(mgr, "for i in $(seq 1 100); do echo noisy-$i; done; sleep 5");
    await waitFor(() => mgr.get(id)?.status === "flooded");

    const text = await inject(mgr);
    expect(text).toContain('status="flooded"');
    expect(text).toContain("narrow the filter");
  });

  it("batches every pending monitor into one injected message", async () => {
    const mgr = new MonitorManager();
    const a = start(mgr, "echo from-a", "watch A");
    const b = start(mgr, "echo from-b", "watch B");
    await waitFor(() => mgr.get(a.id)?.status === "exited" && mgr.get(b.id)?.status === "exited");

    const text = await inject(mgr);
    expect(text).toContain("from-a");
    expect(text).toContain("from-b");
    expect(text).toContain('watching="watch A"');
    expect(text).toContain('watching="watch B"');
  });
});
