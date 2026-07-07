import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODELS,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  hooksConfigSchema,
  isDangerousBash,
  loadProjectHooks,
  loadSettings,
  mergeHooks,
  parseSettings,
  resolveContextWindowSize,
  resolveLanguage,
  resolveMaxTokens,
  resolveModelId,
  settingsSchema,
  type HooksConfig,
} from "./config.js";

describe("settingsSchema", () => {
  it("applies defaults when empty input is given", () => {
    const s = parseSettings({});
    expect(s.model).toBe("pro");
    expect(s.maxTurns).toBe(100);
    expect(s.permissions.defaultEffect).toBe("ask");
    expect(s.permissions.rules).toEqual([]);
    expect(s.transcript.enabled).toBe(true);
    expect(s.sandbox.enabled).toBe(false);
    expect(s.sandbox.monitorViolations).toBe(true);
    expect(s.sandbox.filesystem.allowWrite).toEqual([...DEFAULT_SANDBOX_ALLOW_WRITE]);
    expect(s.sandbox.filesystem.allowGitConfig).toBe(true);
    expect(s.slash.enabled).toBe(true);
    expect(s.slash.projectDirs).toBeUndefined();
    expect(s.slash.userPaths).toBeUndefined();
    expect(s.subagent.enabled).toBe(true);
    expect(s.subagent.maxTurns).toBe(100);
    expect(s.subagent.maxTokens).toBe(32768);
  });

  it("defaults language to auto", () => {
    expect(parseSettings({}).language).toBe("auto");
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
  it("defaults models to the built-in lite/pro/max tiers", () => {
    expect(parseSettings({}).models).toEqual({ ...DEFAULT_MODELS });
  });

  it("a provided models table replaces the default wholesale", () => {
    const s = parseSettings({ model: "mini", models: { mini: { id: "some-mini" } } });
    expect(s.models).toEqual({
      mini: {
        id: "some-mini",
        maxTokens: DEFAULT_MAX_TOKENS,
        contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
        modalities: { input: ["text"] },
      },
    });
  });

  it("accepts profile-object entries with per-tier overrides", () => {
    const s = parseSettings({
      models: {
        flash: { id: "deepseek-v4-flash" },
        pro: { id: "deepseek-v4-pro", maxTokens: 8192, contextWindowSize: 128_000 },
      },
    });
    expect(s.models.flash).toEqual({
      id: "deepseek-v4-flash",
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      modalities: { input: ["text"] },
    });
    expect(s.models.pro).toEqual({
      id: "deepseek-v4-pro",
      maxTokens: 8192,
      contextWindowSize: 128_000,
      modalities: { input: ["text"] },
    });
  });

  it("rejects a profile object missing id", () => {
    expect(() => settingsSchema.parse({ models: { pro: { maxTokens: 8192 } } })).toThrow();
  });

  it("resolves an alias key to its concrete id", () => {
    const s = parseSettings({ model: "flash", models: { flash: { id: "deepseek-v4-flash" } } });
    expect(resolveModelId(s, "flash")).toBe("deepseek-v4-flash");
  });

  it("passes an unknown name through unchanged (aux-model bare id escape hatch)", () => {
    const s = parseSettings({ models: { flash: { id: "deepseek-v4-flash" }, pro: { id: "x" } } });
    expect(resolveModelId(s, "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("rejects a `model` that isn't a configured tier (alias-only)", () => {
    expect(() =>
      settingsSchema.parse({ model: "deepseek-v4-pro", models: { pro: { id: "deepseek-v4-pro" } } }),
    ).toThrow(/not a configured tier/);
  });

  it("accepts a `model` that names a configured tier", () => {
    const s = parseSettings({ model: "pro", models: { pro: { id: "deepseek-v4-pro" } } });
    expect(s.model).toBe("pro");
  });
});

describe("resolveMaxTokens", () => {
  const base = (extra: Record<string, unknown> = {}) => parseSettings({ ...extra });

  it("falls back to DEFAULT_MAX_TOKENS when the tier has no override", () => {
    const s = base({ model: "flash", models: { flash: { id: "deepseek-v4-flash" } } });
    expect(resolveMaxTokens(s, "flash")).toBe(DEFAULT_MAX_TOKENS);
  });

  it("uses the tier's own maxTokens when set (by tier key)", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", maxTokens: 8192 } } });
    expect(resolveMaxTokens(s, "pro")).toBe(8192);
  });

  it("is alias-only: a bare id matching a tier's id does NOT resolve to it", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", maxTokens: 8192 } } });
    expect(resolveMaxTokens(s, "deepseek-v4-pro")).toBe(DEFAULT_MAX_TOKENS);
  });

  it("falls back for an unknown name with no matching tier", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", maxTokens: 8192 } } });
    expect(resolveMaxTokens(s, "claude-sonnet-4-5")).toBe(DEFAULT_MAX_TOKENS);
  });
});

describe("resolveContextWindowSize", () => {
  const base = (extra: Record<string, unknown> = {}) => parseSettings({ ...extra });

  it("falls back to DEFAULT_CONTEXT_WINDOW_SIZE when the tier has no override", () => {
    const s = base({ model: "flash", models: { flash: { id: "deepseek-v4-flash" } } });
    expect(resolveContextWindowSize(s, "flash")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });

  it("uses the tier's own contextWindowSize when set (by tier key)", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } } });
    expect(resolveContextWindowSize(s, "pro")).toBe(800_000);
  });

  it("is alias-only: a bare id matching a tier's id does NOT resolve to it", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } } });
    expect(resolveContextWindowSize(s, "deepseek-v4-pro")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });

  it("falls back for an unknown name with no matching tier", () => {
    const s = base({ models: { pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } } });
    expect(resolveContextWindowSize(s, "claude-sonnet-4-5")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
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
        model: "haiku",
        models: { haiku: { id: "claude-haiku-4-5" } },
        baseURL: "https://file.example.com",
        sessionDir: "/tmp/nova-sessions",
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(s.apiKey).toBe("sk-test-123");
    expect(s.model).toBe("haiku");
    expect(s.baseURL).toBe("https://file.example.com");
    expect(s.sessionDir).toBe("/tmp/nova-sessions");
  });

  it("falls back to defaults when config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const s = await loadSettings(join(dir, "nova.config.json"));
    expect(s.model).toBe("pro");
    expect(s.baseURL).toBe("https://api.deepseek.com/anthropic");
    expect(s.apiKey).toBeUndefined();
    expect(s.sessionDir).toBeUndefined();
  });

  it("accepts per-tier maxTokens in models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({
        models: { pro: { id: "deepseek-v4-pro", maxTokens: 4096 } },
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(s.models.pro?.maxTokens).toBe(4096);
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

describe("resolveLanguage", () => {
  const auto = parseSettings({});
  const empty = {} as NodeJS.ProcessEnv;

  it("returns a non-auto setting verbatim, ignoring the environment", () => {
    const s = parseSettings({ language: "fr-CA" });
    expect(resolveLanguage(s, { LANG: "zh_CN.UTF-8" } as NodeJS.ProcessEnv)).toBe("fr-CA");
  });

  it("normalizes a POSIX locale to a BCP-47-ish tag", () => {
    expect(resolveLanguage(auto, { LANG: "zh_CN.UTF-8" } as NodeJS.ProcessEnv)).toBe("zh-CN");
  });

  it("prefers LC_ALL over LANG over LANGUAGE", () => {
    expect(
      resolveLanguage(auto, {
        LANGUAGE: "de",
        LANG: "ja_JP.UTF-8",
        LC_ALL: "en_US.UTF-8",
      } as NodeJS.ProcessEnv),
    ).toBe("en-US");
  });

  it("treats C/POSIX as no-preference and falls back when env is the only source", () => {
    // On non-macOS hosts (where there is no AppleLocale fallback) C.UTF-8
    // resolves to the explicit fallback.
    if (process.platform !== "darwin") {
      expect(resolveLanguage(auto, { LANG: "C.UTF-8" } as NodeJS.ProcessEnv)).toBe("en");
      expect(resolveLanguage(auto, empty)).toBe("en");
    }
  });

  it("honours a custom fallback", () => {
    if (process.platform !== "darwin") {
      expect(resolveLanguage(auto, empty, "zh-CN")).toBe("zh-CN");
    }
  });
});
