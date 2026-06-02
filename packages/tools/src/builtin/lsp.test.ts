import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LspUnavailableError, type LspManager } from "@nova/lsp";
import type { ToolContext } from "@nova/core";
import { createLspTool } from "./lsp.js";

const ctx: ToolContext = { cwd: "/work" };

function fakeManager(overrides: Partial<LspManager>): LspManager {
  return overrides as unknown as LspManager;
}

describe("lsp tool", () => {
  it("converts 1-based model coords to 0-based LSP coords", async () => {
    let seen: { line: number; character: number } | undefined;
    const tool = createLspTool(
      fakeManager({
        definition: async (_path: string, position) => {
          seen = position;
          return [];
        },
      }),
    );
    await tool.run({ action: "definition", path: "a.ts", line: 5, character: 3 }, ctx);
    expect(seen).toEqual({ line: 4, character: 2 });
  });

  it("defaults character to column 1 (0-based 0)", async () => {
    let seen: { line: number; character: number } | undefined;
    const tool = createLspTool(
      fakeManager({
        hover: async (_path: string, position) => {
          seen = position;
          return undefined;
        },
      }),
    );
    await tool.run({ action: "hover", path: "a.ts", line: 1 }, ctx);
    expect(seen).toEqual({ line: 0, character: 0 });
  });

  it("renders references as relative path:line:col (1-based)", async () => {
    const uri = pathToFileURL("/work/src/foo.ts").href;
    const tool = createLspTool(
      fakeManager({
        references: async () => [
          { uri, range: { start: { line: 9, character: 4 }, end: { line: 9, character: 7 } } },
        ],
      }),
    );
    const res = await tool.run(
      { action: "references", path: "src/foo.ts", line: 1, character: 1 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("src/foo.ts:10:5");
  });

  it("renders diagnostics with severity labels", async () => {
    const tool = createLspTool(
      fakeManager({
        diagnostics: async () => [
          {
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
            severity: 1,
            message: "Cannot find name 'foo'",
            source: "ts",
            code: 2304,
          },
        ],
      }),
    );
    const res = await tool.run({ action: "diagnostics", path: "a.ts" }, ctx);
    expect(res.output).toContain("3:1 error [2304]: ts: Cannot find name 'foo'");
  });

  it("surfaces LspUnavailableError as a non-throwing error result", async () => {
    const tool = createLspTool(
      fakeManager({
        definition: async () => {
          throw new LspUnavailableError("gopls is not installed");
        },
      }),
    );
    const res = await tool.run({ action: "definition", path: "a.go", line: 1 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toBe("gopls is not installed");
  });

  it("requires line for position-based actions", async () => {
    const tool = createLspTool(fakeManager({}));
    const res = await tool.run({ action: "definition", path: "a.ts" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/requires `line`/);
  });

  it("requires a symbol for workspace_symbol", async () => {
    const tool = createLspTool(fakeManager({}));
    const res = await tool.run({ action: "workspace_symbol" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/requires a `symbol`/);
  });
});
