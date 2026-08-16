import { describe, expect, it, vi } from "vitest";
import {
  AppendOnlyViolationError,
  SystemPromptDriftError,
  assertAppendOnly,
  freezeSystemPrompt,
  staticPrompt,
  type SystemPromptProvider,
} from "./ports.js";
import { userText } from "./messages.js";
import type { MessageParam } from "./types.js";

describe("assertAppendOnly", () => {
  const a = userText("a");
  const b = userText("b");

  it("accepts the same array reference", () => {
    const messages = [a, b];
    expect(() => assertAppendOnly(messages, messages)).not.toThrow();
  });

  it("accepts appended messages", () => {
    expect(() => assertAppendOnly([a], [a, b])).not.toThrow();
  });

  it("rejects a shrunk history", () => {
    expect(() => assertAppendOnly([a, b], [a])).toThrow(AppendOnlyViolationError);
    expect(() => assertAppendOnly([a, b], [a])).toThrow(/shrank from 2 to 1/);
  });

  it("rejects an in-place replacement even when the content is identical", () => {
    // Deep-equal but a different object: the persister's prefix check compares
    // serialized lines, and a rewritten entry is exactly what invalidates it.
    const clone: MessageParam = { role: a.role, content: a.content };
    expect(() => assertAppendOnly([a, b], [clone, b])).toThrow(/index 0 was replaced/);
  });

  it("names the source in the message", () => {
    expect(() => assertAppendOnly([a, b], [a], "pre_compact")).toThrow(/^pre_compact broke/);
  });
});

describe("freezeSystemPrompt", () => {
  /** A provider whose prompt and epoch are both mutable, to simulate drift. */
  const mutable = (): SystemPromptProvider & { prompt: string; ep: string } => {
    const p = {
      prompt: "v1",
      ep: "session-1",
      epoch: () => p.ep,
      system: () => p.prompt,
    };
    return p;
  };

  it("keeps the first value seen in an epoch", async () => {
    const inner = mutable();
    const frozen = freezeSystemPrompt(inner);

    expect(await frozen.system()).toBe("v1");
    inner.prompt = "v2";
    expect(await frozen.system()).toBe("v1");
  });

  it("reports drift without throwing by default", async () => {
    const inner = mutable();
    const onDrift = vi.fn();
    const frozen = freezeSystemPrompt(inner, { onDrift });

    await frozen.system();
    inner.prompt = "v2";
    await frozen.system();

    expect(onDrift).toHaveBeenCalledTimes(1);
    expect(onDrift.mock.calls[0]?.[0]).toMatchObject({
      epoch: "session-1",
      frozen: "v1",
      observed: "v2",
    });
  });

  it("throws on drift in strict mode", async () => {
    const inner = mutable();
    const frozen = freezeSystemPrompt(inner, { strict: true });

    await frozen.system();
    inner.prompt = "v2";
    await expect(frozen.system()).rejects.toBeInstanceOf(SystemPromptDriftError);
  });

  it("re-reads when the epoch advances", async () => {
    const inner = mutable();
    const onDrift = vi.fn();
    const frozen = freezeSystemPrompt(inner, { onDrift });

    expect(await frozen.system()).toBe("v1");
    // A session boundary (/clear, /resume) rebuilds the prefix anyway.
    inner.prompt = "v2";
    inner.ep = "session-2";

    expect(await frozen.system()).toBe("v2");
    expect(onDrift).not.toHaveBeenCalled();
  });

  it("does not report drift when the prompt is stable", async () => {
    const onDrift = vi.fn();
    const frozen = freezeSystemPrompt(staticPrompt("fixed", "s"), { onDrift });

    expect(await frozen.system()).toBe("fixed");
    expect(await frozen.system()).toBe("fixed");
    expect(onDrift).not.toHaveBeenCalled();
  });
});

describe("staticPrompt", () => {
  it("returns a constant prompt under a constant epoch", async () => {
    const p = staticPrompt("you are a sub-agent", "child-1");
    expect(p.epoch()).toBe("child-1");
    expect(await p.system()).toBe("you are a sub-agent");
  });
});
