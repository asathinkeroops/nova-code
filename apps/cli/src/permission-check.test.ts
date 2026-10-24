import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsSchema, type PermissionRule, type Settings } from "@nova/base";
import { createContext } from "./context.js";
import { HeadlessScreen } from "./headless-screen.js";
import type { CliContext } from "./ctx-types.js";
import type { PermissionMode } from "./permissions.js";

/**
 * Behavioural tests for the CLI's `checkPermission` ordering, driven through a
 * real `createContext` (its closure is the only place the order lives).
 *
 * Two rules the mode shortcuts used to violate:
 *  - `auto`/`acceptEdits` grant in-workspace writes and auto's classifier
 *    clears commands BEFORE the engine, so a user-configured `deny` rule was
 *    never consulted. It must be.
 *  - "Always allow this tool" answered at auto's risk prompt was treated as a
 *    one-shot yes; the session grant must outlive the prompt.
 */
function isolatedSettings(
  sessionDir: string,
  permissions: {
    rules?: PermissionRule[];
    llmClassifier?: boolean;
    readOnlyDirectories?: string[];
    additionalDirectories?: string[];
  },
): Settings {
  return settingsSchema.parse({
    providers: [
      {
        name: "generic",
        profile: "generic",
        apiKey: "test-key-not-used",
        models: {
          lite: { id: "test-lite" },
          pro: { id: "test-pro" },
          max: { id: "test-max" },
        },
      },
    ],
    sessionDir,
    permissions: {
      ...(permissions.rules ? { rules: permissions.rules } : {}),
      ...(permissions.readOnlyDirectories
        ? { readOnlyDirectories: permissions.readOnlyDirectories }
        : {}),
      ...(permissions.additionalDirectories
        ? { additionalDirectories: permissions.additionalDirectories }
        : {}),
      autoMode: { llmClassifier: permissions.llmClassifier ?? false },
    },
    mcp: { enabled: false },
    guide: { enabled: false, source: "local" },
    memory: { auto: { enabled: false } },
    skills: { userPaths: [] },
    lsp: { enabled: false },
    sandbox: { enabled: false },
    plugins: { enabled: false },
    logging: { pretty: false },
  });
}

interface StartupOptions {
  rules?: PermissionRule[];
  mode?: PermissionMode;
  approvalPolicy?: "allow" | "deny";
  llmClassifier?: boolean;
  readOnlyDirectories?: string[];
  additionalDirectories?: string[];
}

const built: CliContext[] = [];
const dirs: string[] = [];

async function startup(opts: StartupOptions = {}): Promise<CliContext> {
  const workspace = await mkdtemp(join(tmpdir(), "nova-gate-ws-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "nova-gate-sessions-"));
  dirs.push(workspace, sessionDir);
  const screen = new HeadlessScreen({
    permissionMode: opts.mode ?? "auto",
    approvalPolicy: opts.approvalPolicy ?? "deny",
  });
  const ctx = await createContext(
    isolatedSettings(sessionDir, {
      ...(opts.rules ? { rules: opts.rules } : {}),
      ...(opts.llmClassifier !== undefined ? { llmClassifier: opts.llmClassifier } : {}),
      ...(opts.readOnlyDirectories ? { readOnlyDirectories: opts.readOnlyDirectories } : {}),
      ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}),
    }),
    screen,
    { cwd: workspace, noTranscript: true, noPretty: true },
  );
  built.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const ctx of built.splice(0)) {
    ctx.cronScheduler.dispose();
    await ctx.backgroundManager.disposeAll();
    await ctx.monitorManager.disposeAll();
    if (ctx.lspManager) await ctx.lspManager.disposeAll();
    await ctx.sandbox.dispose();
    if (ctx.mcp) await ctx.mcp.close();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("checkPermission — user deny rules outrank mode grants", () => {
  it("denies an in-workspace write that auto would otherwise auto-grant", async () => {
    const ctx = await startup({ rules: [{ tool: "write", effect: "deny" }] });
    const r = await ctx.checkPermission("write", {
      path: join(ctx.workspace, "a.txt"),
      content: "x",
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toMatch(/deny/i);
  });

  it("denies a bash command that auto's classifier would otherwise clear", async () => {
    const ctx = await startup({ rules: [{ tool: "bash", effect: "deny" }] });
    const prompt = vi.spyOn(ctx.screen, "promptApproval");
    const r = await ctx.checkPermission("bash", { command: "ls -la" });
    expect(r.granted).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("denies only the invocations a match rule selects", async () => {
    const ctx = await startup({
      rules: [{ tool: "bash", effect: "deny", match: { command: "/git\\s+push/" } }],
    });
    expect((await ctx.checkPermission("bash", { command: "ls -la" })).granted).toBe(true);
    expect(
      (await ctx.checkPermission("bash", { command: "git push origin feature" })).granted,
    ).toBe(false);
  });

  it("preserves first-match order: an earlier allow rule wins over a later deny", async () => {
    const ctx = await startup({
      rules: [
        { tool: "write", effect: "allow" },
        { tool: "write", effect: "deny" },
      ],
    });
    expect(
      (await ctx.checkPermission("write", { path: join(ctx.workspace, "a.txt"), content: "x" }))
        .granted,
    ).toBe(true);
  });
});

describe("checkPermission — always-allow is remembered for the session", () => {
  it("does not re-prompt for the same command tool after always-allow", async () => {
    const ctx = await startup({ approvalPolicy: "allow", llmClassifier: false });
    const prompt = vi.spyOn(ctx.screen, "promptApproval");

    // Not in the read-only fast path, so auto's classifier (rules-only here,
    // no model) falls back to the risk prompt.
    const first = await ctx.checkPermission("bash", { command: "totally-unknown-cmd-1" });
    expect(first.granted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // A different undecided command: the remembered grant skips the classifier
    // and the prompt entirely.
    const second = await ctx.checkPermission("bash", { command: "totally-unknown-cmd-2" });
    expect(second.granted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("still hard-denies a destructive command after always-allow", async () => {
    const ctx = await startup({ approvalPolicy: "allow", llmClassifier: false });
    // Remember the tool-scoped grant first.
    await ctx.checkPermission("bash", { command: "totally-unknown-cmd" });

    // The remembered grant skips the classifier but must not skip the engine's
    // built-in dangerous-command deny.
    const r = await ctx.checkPermission("bash", { command: "rm -rf /tmp/nova-danger" });
    expect(r.granted).toBe(false);
    expect(r.reason).toMatch(/dangerous/i);
  });

  it("does not let the remembered grant lift plan mode", async () => {
    const ctx = await startup({ approvalPolicy: "allow", llmClassifier: false });
    await ctx.checkPermission("bash", { command: "totally-unknown-cmd" });
    ctx.screen.setPermissionMode("plan");

    const r = await ctx.checkPermission("bash", { command: "ls" });
    expect(r.granted).toBe(false);
    expect(r.reason).toMatch(/plan mode/i);
  });

  it("does not let the remembered grant lift a user deny rule", async () => {
    const ctx = await startup({
      approvalPolicy: "allow",
      llmClassifier: false,
      rules: [{ tool: "bash", effect: "deny" }],
    });
    expect((await ctx.checkPermission("bash", { command: "totally-unknown-cmd" })).granted).toBe(
      false,
    );
  });
});

describe("checkPermission — auto-mode read policy", () => {
  it("allows a read under a toolchain prefix without prompting", async () => {
    const ctx = await startup();
    const prompt = vi.spyOn(ctx.screen, "promptApproval");
    const r = await ctx.checkPermission("read", { path: "/usr/lib/nova-gate-probe.ts" });
    expect(r.granted).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not let the auto read allowlist override a user deny rule", async () => {
    const ctx = await startup({ rules: [{ tool: "read", effect: "deny" }] });
    const r = await ctx.checkPermission("read", { path: "/usr/lib/nova-gate-probe.ts" });
    expect(r.granted).toBe(false);
    expect(r.reason).toMatch(/deny/i);
  });

  it("still asks for an ordinary out-of-workspace read", async () => {
    const ctx = await startup();
    const prompt = vi.spyOn(ctx.screen, "promptApproval");
    // A path outside the toolchain allowlist and outside the workspace (never
    // created — the gate only resolves it, no tool runs).
    const r = await ctx.checkPermission("read", {
      path: join(homedir(), "nova-gate-outside", "a.ts"),
    });
    expect(r.granted).toBe(false); // HeadlessScreen defaults to "deny"
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("asks once per directory after always-allow-dir", async () => {
    const libA = join(homedir(), "nova-gate-lib-a");
    const libB = join(homedir(), "nova-gate-lib-b");
    const ctx = await startup();
    const prompt = vi.spyOn(ctx.screen, "promptApproval").mockResolvedValue("always-allow-dir");

    expect((await ctx.checkPermission("read", { path: join(libA, "a.ts") })).granted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // Same directory (nested) → remembered.
    expect((await ctx.checkPermission("read", { path: join(libA, "sub", "b.ts") })).granted).toBe(
      true,
    );
    expect(prompt).toHaveBeenCalledTimes(1);

    // The grant covers the read family: grep under it does not ask again.
    expect((await ctx.checkPermission("grep", { path: join(libA, "sub") })).granted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // A different directory → asked again.
    expect((await ctx.checkPermission("read", { path: join(libB, "c.ts") })).granted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("never lets a broad directory grant cover a sensitive path", async () => {
    const ctx = await startup();
    const prompt = vi.spyOn(ctx.screen, "promptApproval");
    ctx.permission.allowDirectoryForSession("read", homedir());

    const r = await ctx.checkPermission("read", { path: join(homedir(), ".ssh", "id_rsa") });
    expect(r.granted).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("checkPermission — readOnlyDirectories", () => {
  it("reads without a prompt there, but does not widen auto's write grant", async () => {
    const outside = join(homedir(), "nova-gate-readonly");
    const ctx = await startup({ readOnlyDirectories: [outside] });

    const read = await ctx.checkPermission("read", { path: join(outside, "a.ts") });
    expect(read.granted).toBe(true);

    // auto mode only auto-grants writes inside the WRITE roots; this dir is
    // read-only, so the write falls through to the engine's ask (headless deny).
    const write = await ctx.checkPermission("write", {
      path: join(outside, "a.ts"),
      content: "x",
    });
    expect(write.granted).toBe(false);
  });
});
