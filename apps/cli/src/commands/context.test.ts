import type { MessageParam } from "@nova/core";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../context.js";
import { handleContext } from "./context.js";

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}

interface StubOpts {
  memory?: string;
  skillsBlock?: string;
  messages?: MessageParam[];
  /** Tool names; each gets a small wire schema so its tokens are non-zero. */
  toolNames?: string[];
  autoCompact?: { enabled: boolean; contextWindowPercent?: number };
  contextWindowTokens?: number;
}

function makeCtx(cards: Card[], o: StubOpts = {}): CliContext {
  const toolNames = o.toolNames ?? ["read", "write", "mcp__srv__do"];
  return {
    workspace: "/tmp/ws",
    session: { id: "test-session" },
    memory: { system: o.memory ?? "" },
    skillsBlock: o.skillsBlock ?? "",
    settings: {
      model: "test-model",
      models: {},
      contextWindowTokens: o.contextWindowTokens ?? 128_000,
      compact: { auto: o.autoCompact ?? { enabled: true } },
    },
    tools: {
      definitions: () =>
        toolNames.map((name) => ({
          name,
          description: `does ${name}`,
          inputSchema: undefined,
          inputJsonSchema: { type: "object", properties: { path: { type: "string" } } },
        })),
    },
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      getMessages: () => o.messages ?? [],
    },
  } as unknown as CliContext;
}

/** Strip ANSI so assertions match on plain text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

describe("handleContext", () => {
  it("renders a /context card with the core category rows and window total", () => {
    const cards: Card[] = [];
    handleContext(makeCtx(cards, { messages: [{ role: "user", content: "hello world" }] }));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.opts.title).toBe("/context");
    const text = plain(cards[0]!.text);
    for (const label of ["system prompt", "tools", "messages", "free space"]) {
      expect(text).toContain(label);
    }
    // Header carries the active model and window size.
    expect(text).toContain("test-model");
    expect(text).toContain("128K");
  });

  it("hides the memory row when no memory bundle is loaded, shows it otherwise", () => {
    const without: Card[] = [];
    handleContext(makeCtx(without, { memory: "" }));
    expect(plain(without[0]!.text)).not.toContain("memory files");

    const withMem: Card[] = [];
    handleContext(makeCtx(withMem, { memory: "# Project rules\n".repeat(50) }));
    expect(plain(withMem[0]!.text)).toContain("memory files");
  });

  it("splits MCP tools into their own row", () => {
    const cards: Card[] = [];
    handleContext(makeCtx(cards, { toolNames: ["read", "mcp__srv__do"] }));
    expect(plain(cards[0]!.text)).toContain("mcp tools");

    const noMcp: Card[] = [];
    handleContext(makeCtx(noMcp, { toolNames: ["read", "write"] }));
    expect(plain(noMcp[0]!.text)).not.toContain("mcp tools");
  });

  it("reserves an autocompact buffer when auto-compact is on, none when off", () => {
    const on: Card[] = [];
    handleContext(makeCtx(on, { autoCompact: { enabled: true, contextWindowPercent: 0.5 } }));
    expect(plain(on[0]!.text)).toContain("autocompact buffer");

    const off: Card[] = [];
    handleContext(makeCtx(off, { autoCompact: { enabled: false } }));
    expect(plain(off[0]!.text)).not.toContain("autocompact buffer");
  });
});
