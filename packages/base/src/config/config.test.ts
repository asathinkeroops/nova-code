import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeModels,
  activeProvider,
  activeProviderHeaders,
  activeProviderProfile,
  activeProviderRequestParams,
  API_KEY_ENV,
  apiKeyFromEnv,
  resolveApiKey,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_SANDBOX_ALLOW_WRITE,
  defaultAutoMemoryDir,
  encodeProjectPath,
  hooksConfigSchema,
  isDangerousBash,
  loadProjectHooks,
  loadSettings,
  mergeHooks,
  parseSettings,
  resolveAutoMemoryDir,
  resolveContextWindowSize,
  resolveSkillsIndexBudget,
  resolveLanguage,
  resolveMaxTokens,
  resolveModelId,
  settingsSchema,
  type HooksConfig,
} from "./config.js";

// The schema requires a complete lite/pro/max ladder in any non-empty `models`
// table. This builds one, letting a test spread per-tier overrides (or extra
// tiers) on top while still querying whichever tier it cares about.
const tiers = (overrides: Record<string, unknown> = {}) => ({
  lite: { id: "lite-id" },
  pro: { id: "pro-id" },
  max: { id: "max-id" },
  ...overrides,
});

const withModels = (
  models: Record<string, unknown> = tiers(),
  settings: Record<string, unknown> = {},
) => ({
  providers: [{ name: "test", profile: "generic", models }],
  currentProvider: "test",
  ...settings,
});

const configured = (
  models: Record<string, unknown> = tiers(),
  settings: Record<string, unknown> = {},
) => parseSettings(withModels(models, settings));

describe("settingsSchema", () => {
  it("applies defaults when empty input is given", () => {
    const s = parseSettings({});
    expect(s.model).toBe("pro");
    expect(s.maxTurns).toBe(5000);
    expect(activeProvider(s)).toBeUndefined();
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
    expect(s.subagent.maxTurns).toBe(5000);
    expect(s.subagent.maxTokens).toBe(32768);
  });

  it("defaults language to auto", () => {
    expect(parseSettings({}).language).toBe("auto");
  });

  it("defaults locale to auto", () => {
    expect(parseSettings({}).locale).toBe("auto");
  });

  it("leaves memory.auto.dir unset by default (global per-project store)", () => {
    expect(parseSettings({}).memory.auto.dir).toBeUndefined();
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
  it("leaves models empty by default (populated by a provider template)", () => {
    expect(activeModels(parseSettings({}))).toEqual({});
  });

  it("accepts an empty/unconfigured config without failing tier validation", () => {
    // A fresh/missing config parses (models empty) so setup can run before the
    // provider template writes a real tier table; the model ∈ models refine is
    // skipped while models is empty.
    expect(() => parseSettings({})).not.toThrow();
    expect(parseSettings({}).model).toBe("pro");
  });

  it("normalizes each profile entry, filling per-tier defaults", () => {
    const s = configured();
    expect(activeModels(s).lite).toEqual({
      id: "lite-id",
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      modalities: { input: ["text"] },
    });
  });

  it("accepts profile-object entries with per-tier overrides", () => {
    const s = configured(
      tiers({
        pro: { id: "deepseek-v4-pro", maxTokens: 8192, contextWindowSize: 128_000 },
      }),
    );
    expect(activeModels(s).lite).toEqual({
      id: "lite-id",
      maxTokens: DEFAULT_MAX_TOKENS,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      modalities: { input: ["text"] },
    });
    expect(activeModels(s).pro).toEqual({
      id: "deepseek-v4-pro",
      maxTokens: 8192,
      contextWindowSize: 128_000,
      modalities: { input: ["text"] },
    });
  });

  it("rejects a profile object missing id", () => {
    expect(() => settingsSchema.parse(withModels(tiers({ pro: { maxTokens: 8192 } })))).toThrow();
  });

  it("requires the full lite/pro/max ladder in a non-empty table", () => {
    expect(() =>
      settingsSchema.parse(
        withModels({ lite: { id: "a" }, pro: { id: "b" } }, { model: "pro" }),
      ),
    ).toThrow(/must configure all tiers.*missing: max/);
  });

  it("allows extra tiers on top of the required ladder", () => {
    const s = configured(tiers({ vision: { id: "vision-id" } }));
    expect(resolveModelId(s, "vision")).toBe("vision-id");
  });

  it("resolves an alias key to its concrete id", () => {
    const s = configured(tiers({ lite: { id: "deepseek-v4-flash" } }), { model: "lite" });
    expect(resolveModelId(s, "lite")).toBe("deepseek-v4-flash");
  });

  it("passes an unknown name through unchanged (aux-model bare id escape hatch)", () => {
    const s = configured();
    expect(resolveModelId(s, "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("rejects a `model` that isn't a configured tier (alias-only)", () => {
    expect(() =>
      settingsSchema.parse(withModels(tiers(), { model: "deepseek-v4-pro" })),
    ).toThrow(/not a configured tier/);
  });

  it("keeps configured request headers verbatim", () => {
    const s = parseSettings({
      headers: { "User-Agent": "nova/1.0 (+corp-proxy)", "X-Tenant": "acme" },
    });
    expect(s.headers).toEqual({ "User-Agent": "nova/1.0 (+corp-proxy)", "X-Tenant": "acme" });
  });

  it("leaves headers undefined when unset", () => {
    expect(parseSettings({}).headers).toBeUndefined();
  });

  it("rejects a malformed header name or a value with CR/LF", () => {
    expect(() => settingsSchema.parse({ headers: { "Bad Name": "v" } })).toThrow(
      /invalid HTTP header name/,
    );
    expect(() => settingsSchema.parse({ headers: { "X-A": "v\r\nX-B: injected" } })).toThrow(
      /invalid HTTP header value/,
    );
  });

  it("keeps configured request-body params verbatim", () => {
    const s = parseSettings({
      requestParams: { enable_thinking: true, user: "me", nested: { a: [1, 2] } },
    });
    expect(s.requestParams).toEqual({
      enable_thinking: true,
      user: "me",
      nested: { a: [1, 2] },
    });
  });

  it("leaves requestParams undefined when unset", () => {
    expect(parseSettings({}).requestParams).toBeUndefined();
  });

  it("accepts a `model` that names a configured tier", () => {
    const s = configured(tiers(), { model: "pro" });
    expect(s.model).toBe("pro");
  });
});

describe("resolveMaxTokens", () => {
  // Merge per-tier overrides onto the required lite/pro/max ladder.
  const base = (models: Record<string, unknown> = {}) => configured(tiers(models));

  it("falls back to DEFAULT_MAX_TOKENS when the tier has no override", () => {
    const s = base();
    expect(resolveMaxTokens(s, "lite")).toBe(DEFAULT_MAX_TOKENS);
  });

  it("uses the tier's own maxTokens when set (by tier key)", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", maxTokens: 8192 } });
    expect(resolveMaxTokens(s, "pro")).toBe(8192);
  });

  it("is alias-only: a bare id matching a tier's id does NOT resolve to it", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", maxTokens: 8192 } });
    expect(resolveMaxTokens(s, "deepseek-v4-pro")).toBe(DEFAULT_MAX_TOKENS);
  });

  it("falls back for an unknown name with no matching tier", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", maxTokens: 8192 } });
    expect(resolveMaxTokens(s, "claude-sonnet-4-5")).toBe(DEFAULT_MAX_TOKENS);
  });
});

describe("resolveContextWindowSize", () => {
  const base = (models: Record<string, unknown> = {}) => configured(tiers(models));

  it("falls back to DEFAULT_CONTEXT_WINDOW_SIZE when the tier has no override", () => {
    const s = base();
    expect(resolveContextWindowSize(s, "lite")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });

  it("uses the tier's own contextWindowSize when set (by tier key)", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } });
    expect(resolveContextWindowSize(s, "pro")).toBe(800_000);
  });

  it("is alias-only: a bare id matching a tier's id does NOT resolve to it", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } });
    expect(resolveContextWindowSize(s, "deepseek-v4-pro")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });

  it("falls back for an unknown name with no matching tier", () => {
    const s = base({ pro: { id: "deepseek-v4-pro", contextWindowSize: 800_000 } });
    expect(resolveContextWindowSize(s, "claude-sonnet-4-5")).toBe(DEFAULT_CONTEXT_WINDOW_SIZE);
  });
});

describe("resolveSkillsIndexBudget", () => {
  it("scales with the tier's context window at 4 bytes/token", () => {
    const s = configured(tiers({ pro: { id: "x", contextWindowSize: 1_000_000 } }));
    expect(resolveSkillsIndexBudget(s, "pro")).toBe(40_000);
  });

  it("defaults to ~8000 bytes on a 200k window, matching the previous fixed budget", () => {
    const s = configured(tiers({ pro: { id: "x", contextWindowSize: 200_000 } }));
    expect(resolveSkillsIndexBudget(s, "pro")).toBe(8_000);
  });

  it("honours an explicit maxIndexBytes over the fraction", () => {
    const s = configured(tiers({ pro: { id: "x", contextWindowSize: 1_000_000 } }), {
      skills: { maxIndexBytes: 4_096 },
    });
    expect(resolveSkillsIndexBudget(s, "pro")).toBe(4_096);
  });

  it("honours a custom indexBudgetFraction", () => {
    const s = configured(tiers({ pro: { id: "x", contextWindowSize: 200_000 } }), {
      skills: { indexBudgetFraction: 0.05 },
    });
    expect(resolveSkillsIndexBudget(s, "pro")).toBe(40_000);
  });

  it("never returns a budget below 1", () => {
    const s = configured(tiers({ pro: { id: "x", contextWindowSize: 1 } }), {
      skills: { indexBudgetFraction: 0.0000001 },
    });
    expect(resolveSkillsIndexBudget(s, "pro")).toBe(1);
  });
});

describe("loadSettings", () => {
  // An exported key would otherwise change resolveApiKey expectations.
  const priorApiKeyEnv = process.env[API_KEY_ENV];
  beforeEach(() => {
    delete process.env[API_KEY_ENV];
  });
  afterEach(() => {
    if (priorApiKeyEnv === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = priorApiKeyEnv;
  });

  it("reads model, baseURL, apiKey, sessionDir from config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({
        model: "haiku",
        providers: [
          {
            name: "test",
            profile: "generic",
            apiKey: "sk-test-123",
            baseURL: "https://file.example.com",
            models: tiers({ haiku: { id: "claude-haiku-4-5" } }),
          },
        ],
        currentProvider: "test",
        sessionDir: "/tmp/nova-sessions",
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(resolveApiKey(s)).toBe("sk-test-123");
    expect(s.model).toBe("haiku");
    expect(activeProvider(s)?.baseURL).toBe("https://file.example.com");
    expect(s.sessionDir).toBe("/tmp/nova-sessions");
  });

  it("falls back to defaults when config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const s = await loadSettings(join(dir, "nova.config.json"));
    expect(s.model).toBe("pro");
    expect(activeProvider(s)).toBeUndefined();
    expect(resolveApiKey(s)).toBeUndefined();
    expect(s.sessionDir).toBeUndefined();
  });

  it("folds $NOVA_API_KEY in, overriding the file's apiKey", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({ providers: [{ name: "test", profile: "generic", apiKey: "from-config" }] }),
      "utf8",
    );
    const prior = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = "from-env";
    try {
      expect(resolveApiKey(await loadSettings(path))).toBe("from-env");
    } finally {
      if (prior === undefined) delete process.env[API_KEY_ENV];
      else process.env[API_KEY_ENV] = prior;
    }
  });

  it("accepts per-tier maxTokens in models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({
        ...withModels(tiers({ pro: { id: "deepseek-v4-pro", maxTokens: 4096 } })),
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(activeModels(s).pro?.maxTokens).toBe(4096);
  });
});

describe("resolveApiKey", () => {
  const withKey = parseSettings({
    providers: [{ name: "test", profile: "generic", apiKey: "from-config" }],
  });
  const keyless = parseSettings({});
  const env = (value?: string): NodeJS.ProcessEnv =>
    (value === undefined ? {} : { [API_KEY_ENV]: value }) as NodeJS.ProcessEnv;

  it("prefers the environment over the config file", () => {
    expect(resolveApiKey(withKey, env("from-env"))).toBe("from-env");
  });

  it("falls back to the config file when the env var is unset", () => {
    expect(resolveApiKey(withKey, env())).toBe("from-config");
  });

  it("treats a blank env var as unset and trims the value", () => {
    expect(resolveApiKey(withKey, env("   "))).toBe("from-config");
    expect(resolveApiKey(keyless, env("  from-env  "))).toBe("from-env");
    expect(apiKeyFromEnv(env(""))).toBeUndefined();
  });

  it("returns undefined when neither source has a key", () => {
    expect(resolveApiKey(keyless, env())).toBeUndefined();
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

describe("auto-memory path resolution", () => {
  it("encodes an absolute path Claude-Code-style (non-alnum -> '-')", () => {
    expect(encodeProjectPath("/Users/me/dev/nova-code")).toBe("-Users-me-dev-nova-code");
    expect(encodeProjectPath("/Users/me/.config/app")).toBe("-Users-me--config-app");
  });

  it("resolves relative workspaces before encoding, so the segment is absolute", () => {
    const abs = encodeProjectPath(process.cwd());
    expect(encodeProjectPath(".")).toBe(abs);
    expect(abs.startsWith("-")).toBe(true);
  });

  it("defaults to ~/.nova/projects/<encoded>/memory under the given home", () => {
    expect(defaultAutoMemoryDir("/Users/me/dev/app", "/home/me")).toBe(
      "/home/me/.nova/projects/-Users-me-dev-app/memory",
    );
  });

  it("uses the global per-project store when no dir override is given", () => {
    expect(resolveAutoMemoryDir("/ws", undefined, "/home/me")).toBe(
      "/home/me/.nova/projects/-ws/memory",
    );
  });

  it("resolves a relative dir override against the workspace root", () => {
    expect(resolveAutoMemoryDir("/ws", ".nova/memory", "/home/me")).toBe("/ws/.nova/memory");
  });

  it("passes an absolute dir override through unchanged", () => {
    expect(resolveAutoMemoryDir("/ws", "/elsewhere/mem", "/home/me")).toBe("/elsewhere/mem");
  });
});

describe("provider transport", () => {
  it("parses an explicit wire-protocol override", () => {
    expect(activeProvider(parseSettings({ providers: [{ name: "x", transport: "openai" }] }))?.transport).toBe("openai");
    expect(
      activeProvider(parseSettings({ providers: [{ name: "x", transport: "anthropic" }] }))
        ?.transport,
    ).toBe("anthropic");
  });
  it("rejects a bogus transport value", () => {
    expect(() => parseSettings({ providers: [{ name: "x", transport: "gemini" }] })).toThrow();
  });
});

describe("providers array & currentProvider access", () => {
  it("resolves all provider-local values from the active entry", () => {
    const s = parseSettings({
      providers: [
        {
          name: "a",
          profile: "deepseek",
          baseURL: "https://a.example.com",
          transport: "openai",
          apiKey: "ka",
          models: tiers(),
        },
        {
          name: "b",
          profile: "moonshot",
          baseURL: "https://b.example.com",
          transport: "anthropic",
          apiKey: "kb",
          models: tiers(),
        },
      ],
      currentProvider: "b",
      model: "pro",
    });
    expect(activeProviderProfile(s)).toBe("moonshot");
    expect(activeProvider(s)?.baseURL).toBe("https://b.example.com");
    expect(activeProvider(s)?.transport).toBe("anthropic");
    expect(resolveApiKey(s)).toBe("kb");
    expect(activeModels(s).pro?.id).toBe("pro-id");
    expect(s.providers).toHaveLength(2);
  });

  it("defaults currentProvider to the first entry", () => {
    const s = parseSettings({
      providers: [
        {
          name: "a",
          profile: "deepseek",
          baseURL: "https://a.example.com",
          apiKey: "ka",
          models: tiers(),
        },
      ],
    });
    expect(s.currentProvider).toBe("a");
    expect(activeProviderProfile(s)).toBe("deepseek");
    expect(activeProvider(s)?.baseURL).toBe("https://a.example.com");
    expect(resolveApiKey(s)).toBe("ka");
  });

  it("rejects a currentProvider that does not reference an entry", () => {
    const result = settingsSchema.safeParse({
      providers: [{ name: "a", profile: "deepseek", apiKey: "ka" }],
      currentProvider: "missing",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["currentProvider"],
          message: 'currentProvider "missing" does not name a configured provider',
        }),
      );
    }
  });

  it("rejects duplicate provider names", () => {
    const result = settingsSchema.safeParse({
      providers: [
        { name: "same", profile: "deepseek", apiKey: "ka" },
        { name: "same", profile: "moonshot", apiKey: "kb" },
      ],
      currentProvider: "same",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["providers", 1, "name"],
          message: 'provider name "same" is duplicated — names must be unique',
        }),
      );
    }
  });

  it("keeps the runtime schema new-only when the file adapter is bypassed", () => {
    for (const field of ["provider", "baseURL", "apiKey", "models", "transport"]) {
      expect(() => parseSettings({ [field]: field === "models" ? {} : "removed" })).toThrow(
        /Unrecognized key/,
      );
    }
  });

  it("keeps an empty providers array as the unconfigured state", () => {
    const s = parseSettings({});
    expect(s.providers).toEqual([]);
    expect(activeModels(s)).toEqual({});
  });

  it("merges a provider's headers over the global default", () => {
    const s = parseSettings({
      headers: { "X-Global": "1" },
      providers: [
        {
          name: "a",
          profile: "deepseek",
          baseURL: "https://a.example.com",
          apiKey: "k",
          headers: { "X-Provider": "2" },
          models: tiers(),
        },
      ],
    });
    expect(s.headers).toEqual({ "X-Global": "1" });
    expect(activeProviderHeaders(s)).toEqual({ "X-Global": "1", "X-Provider": "2" });
  });

  it("merges a provider's requestParams over the global default", () => {
    const s = parseSettings({
      requestParams: { enable_thinking: true, user: "global" },
      providers: [
        {
          name: "a",
          profile: "deepseek",
          baseURL: "https://a.example.com",
          apiKey: "k",
          requestParams: { user: "provider" },
          models: tiers(),
        },
      ],
    });
    expect(s.requestParams).toEqual({ enable_thinking: true, user: "global" });
    expect(activeProviderRequestParams(s)).toEqual({
      enable_thinking: true,
      user: "provider",
    });
  });
});
