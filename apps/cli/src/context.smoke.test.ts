import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsSchema, type Settings } from "@nova/base";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "./context.js";
import { HeadlessScreen } from "./headless-screen.js";
import type { CliContext } from "./ctx-types.js";

/**
 * Startup wiring smoke test.
 *
 * `createContext` is ~1200 lines of assembly that no unit test touches: it
 * builds the permission engine, tool registry, agent, slash registries, skill
 * index, hooks and session state, then hands back a live context. A single
 * mistake in that wiring — a missing import, a bad call order, an unawaited
 * promise — takes the CLI down at launch while every unit test stays green.
 * That has happened (see `fix(cli): import pluginSkillRoots into context.ts`).
 *
 * So this asserts the one thing unit tests structurally cannot: that startup
 * runs to completion and produces a context with its parts attached. It is
 * deliberately shallow on behaviour — the individual pieces have their own
 * tests — and its value is entirely in *executing* the assembly path.
 *
 * Everything that would reach the network or the developer's real `~/.nova` is
 * switched off below; `apiKey` is a placeholder because the model client is
 * constructed but never called.
 */
function isolatedSettings(sessionDir: string): Settings {
  return settingsSchema.parse({
    apiKey: "test-key-not-used",
    sessionDir,
    // No outbound connections from a test run.
    mcp: { enabled: false },
    // `guide.source: "remote"` kicks off a background `git clone` of the nova
    // repo at startup; "local" resolves to the workspace and clones nothing.
    guide: { enabled: false, source: "local" },
    // Auto-memory writes under ~/.nova by design; keep the test off the real
    // store (see the auto-memory-is-personal note in the memory docs).
    memory: { auto: { enabled: false } },
    // Same reason: the default scan walks the real `~/.nova/skills`, so an
    // installed skill would leak into the block this file asserts is empty.
    skills: { userPaths: [] },
    lsp: { enabled: false },
    sandbox: { enabled: false },
    plugins: { enabled: false },
    logging: { pretty: false },
  });
}

const built: CliContext[] = [];

async function startup(): Promise<CliContext> {
  const workspace = mkdtempSync(join(tmpdir(), "nova-smoke-ws-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "nova-smoke-sessions-"));
  const ctx = await createContext(isolatedSettings(sessionDir), new HeadlessScreen(), {
    cwd: workspace,
    noTranscript: true,
    noPretty: true,
  });
  built.push(ctx);
  return ctx;
}

afterEach(async () => {
  // Mirrors the REPL's own shutdown sequence (`shutdown` in repl.ts). Startup
  // arms a cron scheduler and holds a sandbox handle; leaving them live keeps
  // vitest's process alive after the suite finishes.
  for (const ctx of built.splice(0)) {
    ctx.cronScheduler.dispose();
    await ctx.backgroundManager.disposeAll();
    await ctx.monitorManager.disposeAll();
    if (ctx.lspManager) await ctx.lspManager.disposeAll();
    await ctx.sandbox.dispose();
    if (ctx.mcp) await ctx.mcp.close();
  }
});

describe("createContext — startup wiring", () => {
  it("completes without throwing and returns a wired context", async () => {
    const ctx = await startup();
    expect(ctx.workspace).toBeTruthy();
    expect(ctx.session.id).toBeTruthy();
    expect(ctx.agent).toBeTruthy();
    expect(ctx.permission).toBeTruthy();
    expect(ctx.registry).toBeTruthy();
    expect(ctx.checkPermission).toBeTypeOf("function");
    expect(ctx.dispatch).toBeTypeOf("function");
  });

  it("registers the built-in tools and slash commands", async () => {
    const ctx = await startup();
    const toolNames = ctx.tools.definitions().map((d) => d.name);
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(ctx.registry.list().length).toBeGreaterThan(0);
  });

  it("builds a skills block without a skill directory present", async () => {
    // The empty-workspace path: no SKILL.md anywhere, so the block collapses to
    // "" and the system prompt drops the section entirely.
    const ctx = await startup();
    expect(ctx.skillsBlock).toBe("");
  });
});
