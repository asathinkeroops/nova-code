import type { MessageParam } from "@nova/core";
import { describe, expect, it } from "vitest";
import type { CliContext } from "../context.js";
import { handleContext } from "./context.js";

interface Viewer {
  lines: string[];
  header?: string;
  footer?: string;
}

interface StubOpts {
  memory?: string;
  skillsBlock?: string;
  messages?: MessageParam[];
  /** Tool names; each gets a small wire schema so its tokens are non-zero. */
  toolNames?: string[];
  autoCompact?: { enabled: boolean; contextWindowPercent?: number };
  contextWindowSize?: number;
}

function makeCtx(viewers: Viewer[], o: StubOpts = {}): CliContext {
  const toolNames = o.toolNames ?? ["read", "write", "mcp__srv__do"];
  // Binary magnitude, like the built-in tables: a "128K" window is 128 × 1024.
  const windowTokens = o.contextWindowSize ?? 128 * 1024;
  return {
    workspace: "/tmp/ws",
    session: { id: "test-session" },
    memory: { system: o.memory ?? "" },
    skillsBlock: o.skillsBlock ?? "",
    settings: {
      model: "test-model",
      providers: [
        {
          name: "test",
          profile: "other",
          models: { "test-model": { id: "test-model", contextWindowSize: windowTokens } },
        },
      ],
      currentProvider: "test",
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
      viewer: async (opts: { lines: string[]; header?: string; footer?: string }) => {
        viewers.push({ lines: opts.lines, header: opts.header, footer: opts.footer });
      },
      getMessages: () => o.messages ?? [],
    },
  } as unknown as CliContext;
}

/** Strip ANSI so assertions match on plain text. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

/** The header + body lines of the one viewer that was opened, ANSI-stripped. */
function viewerText(viewers: Viewer[]): string {
  expect(viewers).toHaveLength(1);
  const v = viewers[0]!;
  return plain([v.header ?? "", ...v.lines].join("\n"));
}

describe("handleContext", () => {
  it("opens a /context viewer with the core category rows and window total", async () => {
    const viewers: Viewer[] = [];
    await handleContext(makeCtx(viewers, { messages: [{ role: "user", content: "hello world" }] }));
    const text = viewerText(viewers);
    for (const label of ["system prompt", "tools", "messages", "free space"]) {
      expect(text).toContain(label);
    }
    // Header carries the active model; the gauge line carries the window size.
    expect(text).toContain("test-model");
    expect(text).toContain("128K");
  });

  it("hides the memory row when no memory bundle is loaded, shows it otherwise", async () => {
    const without: Viewer[] = [];
    await handleContext(makeCtx(without, { memory: "" }));
    expect(viewerText(without)).not.toContain("memory files");

    const withMem: Viewer[] = [];
    await handleContext(makeCtx(withMem, { memory: "# Project rules\n".repeat(50) }));
    expect(viewerText(withMem)).toContain("memory files");
  });

  it("splits MCP tools into their own row", async () => {
    const cards: Viewer[] = [];
    await handleContext(makeCtx(cards, { toolNames: ["read", "mcp__srv__do"] }));
    expect(viewerText(cards)).toContain("mcp tools");

    const noMcp: Viewer[] = [];
    await handleContext(makeCtx(noMcp, { toolNames: ["read", "write"] }));
    expect(viewerText(noMcp)).not.toContain("mcp tools");
  });

  it("reserves an autocompact buffer when auto-compact is on, none when off", async () => {
    const on: Viewer[] = [];
    await handleContext(makeCtx(on, { autoCompact: { enabled: true, contextWindowPercent: 0.5 } }));
    expect(viewerText(on)).toContain("autocompact buffer");

    const off: Viewer[] = [];
    await handleContext(makeCtx(off, { autoCompact: { enabled: false } }));
    expect(viewerText(off)).not.toContain("autocompact buffer");
  });
});
