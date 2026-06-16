import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  hooksConfigSchema,
  isDangerousBash,
  loadProjectHooks,
  loadSettings,
  mergeHooks,
  parseSettings,
  resolveContextWindowTokens,
  resolveModelId,
  settingsSchema,
  type HooksConfig,
} from "./config.js";

describe("settingsSchema", () => {
  it("applies defaults when empty input is given", () => {
    const s = parseSettings({});
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.maxTokens).toBe(32768);
    expect(s.maxTurns).toBe(50);
    expect(s.permissions.defaultEffect).toBe("ask");
    expect(s.permissions.rules).toEqual([]);
    expect(s.transcript.enabled).toBe(true);
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.monitorViolations).toBe(true);
    expect(s.sandbox.filesystem.allowWrite).toEqual([...DEFAULT_SANDBOX_ALLOW_WRITE]);
    expect(s.sandbox.filesystem.allowGitConfig).toBe(true);
    expect(s.slash.enabled).toBe(true);
    expect(s.slash.projectDirs).toBeUndefined();
    expect(s.slash.userPaths).toBeUndefined();
    expect(s.subagent.enabled).toBe(true);
    expect(s.subagent.maxTurns).toBe(50);
    expect(s.subagent.maxTokens).toBe(32768);
  });

  it("accepts slash overrides", () => {
    const s = parseSettings({
      slash: { enabled: false, projectDirs: ["prompts"], userPaths: ["~/.my/cmds"] },
    });
    expect(s.slash.enabled).toBe(false);
    expect(s.slash.projectDirs).toEqual(["prompts"]);
    expect(s.slash.userPaths).toEqual(["~/.my/cmds"]);
  });

  it("accepts permission rules", () => {
    const s = parseSettings({
      permissions: {
        defaultEffect: "ask",
        rules: [{ tool: "bash", effect: "allow", match: { command: "ls" } }],
      },
    });
    expect(s.permissions.rules).toHaveLength(1);
    expect(s.permissions.rules[0]?.effect).toBe("allow");
  });

  it("rejects unknown effect", () => {
    expect(() =>
      settingsSchema.parse({
        permissions: { defaultEffect: "nope", rules: [] },
      }),
    ).toThrow();
  });
});

describe("model tiers", () => {
  it("defaults models to the built-in flash/pro tiers", () => {
    expect(parseSettings({}).models).toEqual({ ...DEFAULT_MODELS });
  });

  it("a provided models table replaces the default wholesale", () => {
    const s = parseSettings({ models: { mini: "some-mini" } });
    expect(s.models).toEqual({ mini: "some-mini" });
  });

  it("accepts bare-id and (reserved) profile-object entries", () => {
    const s = parseSettings({
      models: {
        flash: "deepseek-v4-flash",
        pro: { id: "deepseek-v4-pro", maxTokens: 8192 },
      },
    });
    expect(s.models.flash).toBe("deepseek-v4-flash");
    expect(s.models.pro).toEqual({ id: "deepseek-v4-pro", maxTokens: 8192 });
  });

  it("rejects a profile object missing id", () => {
    expect(() => settingsSchema.parse({ models: { pro: { maxTokens: 8192 } } })).toThrow();
  });

  it("resolves an alias key to its concrete id", () => {
    const s = parseSettings({ models: { flash: "deepseek-v4-flash" } });
    expect(resolveModelId(s, "flash")).toBe("deepseek-v4-flash");
  });

  it("resolves the id of a profile-object entry", () => {
    const s = parseSettings({ models: { pro: { id: "deepseek-v4-pro" } } });
    expect(resolveModelId(s, "pro")).toBe("deepseek-v4-pro");
  });

  it("passes an unknown name through unchanged (bare id)", () => {
    const s = parseSettings({ models: { flash: "deepseek-v4-flash" } });
    expect(resolveModelId(s, "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("accepts a per-tier contextWindowTokens override", () => {
    const s = parseSettings({
      models: { pro: { id: "deepseek-v4-pro", contextWindowTokens: 500_000 } },
    });
    const entry = s.models.pro;
    expect(typeof entry === "object" && entry.contextWindowTokens).toBe(500_000);
  });
});

describe("resolveContextWindowTokens", () => {
  const base = (extra: Record<string, unknown> = {}) =>
    parseSettings({ contextWindowTokens: 256_000, ...extra });

  it("falls back to the top-level value when the tier has no override", () => {
    const s = base({ models: { flash: "deepseek-v4-flash" } });
    expect(resolveContextWindowTokens(s, "flash")).toBe(256_000);
  });

  it("uses the tier's own contextWindowTokens when set (by tier key)", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowTokens: 800_000 } } });
    expect(resolveContextWindowTokens(s, "pro")).toBe(800_000);
  });

  it("matches a profile tier by resolved id when given a bare model id", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowTokens: 800_000 } } });
    expect(resolveContextWindowTokens(s, "deepseek-v4-pro")).toBe(800_000);
  });

  it("falls back for an unknown name with no matching tier", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowTokens: 800_000 } } });
    expect(resolveContextWindowTokens(s, "claude-sonnet-4-5")).toBe(256_000);
  });
});

describe("loadSettings", () => {
  it("reads model, baseURL, apiKey, sessionDir from config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({
        apiKey: "sk-test-123",
        model: "claude-haiku-4-5",
        baseURL: "https://file.example.com",
        sessionDir: "/tmp/nova-sessions",
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(s.apiKey).toBe("sk-test-123");
    expect(s.model).toBe("claude-haiku-4-5");
    expect(s.baseURL).toBe("https://file.example.com");
    expect(s.sessionDir).toBe("/tmp/nova-sessions");
  });

  it("falls back to defaults when config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const s = await loadSettings(join(dir, "nova.config.json"));
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.baseURL).toBeUndefined();
    expect(s.apiKey).toBeUndefined();
    expect(s.sessionDir).toBeUndefined();
  });
});

describe("hooks config", () => {
  it("defaults to an empty, enabled hooks section with all 8 event arrays", () => {
    const s = parseSettings({});
    expect(s.hooks.enabled).toBe(true);
    expect(Object.keys(s.hooks).sort()).toEqual(
      [
        "PostCompact",
        "PostToolUse",
        "PreCompact",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
        "enabled",
      ].sort(),
    );
    expect(s.hooks.PreToolUse).toEqual([]);
  });

  it("standalone hook files parse and fill per-hook defaults", () => {
    const h = hooksConfigSchema.parse({
      PostToolUse: [{ matcher: "write", command: "fmt" }],
    });
    expect(h.PostToolUse[0]?.timeout_ms).toBe(60000);
    expect(h.SessionStart).toEqual([]);
  });
});

describe("mergeHooks", () => {
  const cfg = (partial: Partial<HooksConfig>): HooksConfig => hooksConfigSchema.parse(partial);

  it("accumulates arrays across sources instead of overriding", () => {
    const global = cfg({ PostToolUse: [{ command: "g", timeout_ms: 1000 }] });
    const project = cfg({ PostToolUse: [{ command: "p", timeout_ms: 1000 }] });
    const merged = mergeHooks([global, project]);
    expect(merged.PostToolUse.map((h) => h.command)).toEqual(["g", "p"]);
  });

  it("de-duplicates identical (matcher, command) entries, first wins", () => {
    const a = cfg({ PreToolUse: [{ matcher: "bash", command: "guard", timeout_ms: 1000 }] });
    const b = cfg({ PreToolUse: [{ matcher: "bash", command: "guard", timeout_ms: 5000 }] });
    const merged = mergeHooks([a, b]);
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.PreToolUse[0]?.timeout_ms).toBe(1000);
  });

  it("enabled is the AND across sources", () => {
    expect(mergeHooks([cfg({ enabled: true }), cfg({ enabled: true })]).enabled).toBe(true);
    expect(mergeHooks([cfg({ enabled: true }), cfg({ enabled: false })]).enabled).toBe(false);
  });
});

describe("loadProjectHooks", () => {
  it("loads .nova/hooks.json and .nova/hooks.local.json in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-hooks-"));
    await mkdir(join(dir, ".nova"), { recursive: true });
    await writeFile(
      join(dir, ".nova", "hooks.json"),
      JSON.stringify({ PostToolUse: [{ command: "shared" }] }),
      "utf8",
    );
    await writeFile(
      join(dir, ".nova", "hooks.local.json"),
      JSON.stringify({ PostToolUse: [{ command: "local-only" }] }),
      "utf8",
    );
    const result = await loadProjectHooks(dir);
    expect(result.errors).toEqual([]);
    expect(result.loaded.map((l) => l.hooks.PostToolUse[0]?.command)).toEqual([
      "shared",
      "local-only",
    ]);
  });

  it("skips missing files and reports malformed ones without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-hooks-"));
    await mkdir(join(dir, ".nova"), { recursive: true });
    await writeFile(join(dir, ".nova", "hooks.json"), "{ not json", "utf8");
    const result = await loadProjectHooks(dir);
    expect(result.loaded).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toContain("hooks.json");
  });

  it("returns nothing when no project hook files exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-hooks-"));
    const result = await loadProjectHooks(dir);
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("isDangerousBash", () => {
  it.each([
    ["rm -rf /", true],
    ["rm -rf /usr", true],
    ["rm -rf ./build", false],
    [":(){ :|:& };:", true],
    ["mkfs.ext4 /dev/sda1", true],
    ["dd if=/dev/zero of=/dev/sda", true],
    ["ls -la", false],
    ["echo hello", false],
  ])("classifies %s -> %s", (cmd, expected) => {
    expect(isDangerousBash(cmd)).toBe(expected);
  });
});
