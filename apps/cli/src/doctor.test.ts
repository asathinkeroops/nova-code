import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeModels, API_KEY_ENV, resolveApiKey } from "@nova/base";
import {
  buildFixPrompt,
  diagnoseConfig,
  formatDoctorReport,
  formatInvalidConfigError,
  summarizeReport,
} from "./doctor.js";

const VALID_MODELS = {
  lite: { id: "lite-id", contextWindowSize: 200000, maxTokens: 8192 },
  pro: { id: "pro-id", contextWindowSize: 200000, maxTokens: 8192 },
  max: { id: "max-id", contextWindowSize: 200000, maxTokens: 8192 },
};

const providerConfig = (
  entry: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) => ({
  providers: [{ name: "test", profile: "generic", ...entry }],
  currentProvider: "test",
  model: "pro",
  ...settings,
});

/** A minimal, fully-valid config: apiKey + all required tiers + a valid active model. */
const VALID_CONFIG = providerConfig({ apiKey: "sk-test", models: VALID_MODELS });

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-doctor-"));
  const path = join(dir, "nova.config.json");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("diagnoseConfig", () => {
  // An exported key would otherwise change resolveApiKey and doctor findings.
  const priorApiKeyEnv = process.env[API_KEY_ENV];
  beforeEach(() => {
    delete process.env[API_KEY_ENV];
  });
  afterEach(() => {
    if (priorApiKeyEnv === undefined) delete process.env[API_KEY_ENV];
    else process.env[API_KEY_ENV] = priorApiKeyEnv;
  });

  it("treats a missing file as the fresh-install state, not an error", async () => {
    const { report, settings } = await diagnoseConfig({
      configPath: join(tmpdir(), "definitely-missing-nova.json"),
    });
    expect(report.exists).toBe(false);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    // Falls back to a usable, all-defaults config.
    expect(Object.keys(activeModels(settings))).toHaveLength(0);
  });

  it("reports invalid JSON as a hard error and falls back to defaults", async () => {
    const path = await writeConfig("{ not valid json ");
    const { report, settings } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.level).toBe("error");
    expect(report.issues[0]?.title).toMatch(/not valid JSON/);
    expect(resolveApiKey(settings)).toBeUndefined();
  });

  it("reports a missing model tier via the schema refinement", async () => {
    const bad = providerConfig({
      apiKey: "sk-test",
      models: { lite: VALID_MODELS.lite, pro: VALID_MODELS.pro },
    });
    const path = await writeConfig(JSON.stringify(bad));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    expect(
      report.issues.some(
        (i) => i.level === "error" && i.title.includes("providers") && i.detail?.includes("max"),
      ),
    ).toBe(true);
  });

  it("reports an active model that is not a configured tier", async () => {
    const bad = { ...VALID_CONFIG, model: "ultra" };
    const path = await writeConfig(JSON.stringify(bad));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.title.includes("model"))).toBe(true);
  });

  it("passes a fully-valid config with no issues", async () => {
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const { report, settings } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(resolveApiKey(settings)).toBe("sk-test");
  });

  it("automatically migrates a legacy flat provider config before validation", async () => {
    const path = await writeConfig(
      JSON.stringify({
        provider: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-test",
        transport: "openai",
        model: "pro",
      }),
    );

    const { report, settings } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(resolveApiKey(settings)).toBe("sk-test");
    const migrated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(migrated["provider"]).toBeUndefined();
    expect(migrated["apiKey"]).toBeUndefined();
    expect(migrated["currentProvider"]).toBe("deepseek");
  });

  it("warns when no apiKey is configured", async () => {
    const path = await writeConfig(JSON.stringify(providerConfig({ models: VALID_MODELS })));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes("no apiKey"));
    expect(warn?.level).toBe("warn");
  });

  it("accepts $NOVA_API_KEY in place of a configured apiKey, and says so", async () => {
    process.env[API_KEY_ENV] = "sk-from-env";
    const path = await writeConfig(JSON.stringify(providerConfig({ models: VALID_MODELS })));
    const { report, settings } = await diagnoseConfig({ configPath: path });
    expect(resolveApiKey(settings)).toBe("sk-from-env");
    expect(report.issues.some((i) => i.title.includes("no apiKey"))).toBe(false);
    expect(report.info.some((l) => l.includes(API_KEY_ENV))).toBe(true);
  });

  it("lets $NOVA_API_KEY override the apiKey in the config file", async () => {
    process.env[API_KEY_ENV] = "sk-from-env";
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const { settings } = await diagnoseConfig({ configPath: path });
    expect(resolveApiKey(settings)).toBe("sk-from-env");
  });

  it("warns when an apiKey is set but the models table is empty", async () => {
    const path = await writeConfig(JSON.stringify(providerConfig({ apiKey: "sk-test" })));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes("no models are configured"));
    expect(warn?.level).toBe("warn");
  });

  it("warns when provider is not a built-in profile (falls back to `generic`)", async () => {
    const path = await writeConfig(
      JSON.stringify(
        providerConfig({ profile: "deepsek", apiKey: "sk-test", models: VALID_MODELS }),
      ),
    );
    const { report } = await diagnoseConfig({ configPath: path });
    // A free-form provider id is schema-valid — it just resolves to `generic`.
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes('provider "deepsek"'));
    expect(warn?.level).toBe("warn");
  });

  it("does not warn for a built-in provider id", async () => {
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.title.includes("provider"))).toBe(false);
  });
});

describe("report formatting", () => {
  it("summarizes error and warning counts", async () => {
    const path = await writeConfig(JSON.stringify(providerConfig({ apiKey: "sk-test" })));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(summarizeReport(report)).toBe("0 errors, 1 warning");
  });

  it("gives a clean bill of health for a valid config", async () => {
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(formatDoctorReport(report)).toMatch(/looks good/);
  });

  it("builds a fix prompt that lists the issues and preserves the apiKey", async () => {
    const path = await writeConfig(
      JSON.stringify(providerConfig({ apiKey: "sk-test", models: { pro: { id: "b" } } })),
    );
    const { report } = await diagnoseConfig({ configPath: path });
    const prompt = buildFixPrompt(report);
    expect(prompt).toMatch(/missing: lite, max/);
    expect(prompt).toMatch(/preserve everything else/i);
    expect(prompt).toMatch(/apiKey/);
  });
});

describe("MCP summary + project hooks", () => {
  it("adds an MCP summary info line for a valid config with servers", async () => {
    const withMcp = {
      ...VALID_CONFIG,
      mcp: { servers: { fs: { command: "mcp-fs" }, remote: { type: "http", url: "https://x.example/mcp" } } },
    };
    const path = await writeConfig(JSON.stringify(withMcp));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    expect(report.info.some((l) => /MCP: 2 server/.test(l))).toBe(true);
  });

  it("reports a malformed project hook file as a non-blocking warning", async () => {
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const workspace = await mkdtemp(join(tmpdir(), "nova-ws-"));
    await mkdir(join(workspace, ".nova"), { recursive: true });
    await writeFile(join(workspace, ".nova", "hooks.json"), "{ broken ", "utf8");
    const { report } = await diagnoseConfig({ configPath: path, workspace });
    // Global config is still valid — a bad hook file must not flip validity.
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes("invalid hook file"));
    expect(warn?.level).toBe("warn");
  });

  it("states the real errors (not a misleading apiKey message) for an invalid config", async () => {
    // apiKey IS set, but the models table is incomplete — the config is invalid.
    const path = await writeConfig(
      JSON.stringify(providerConfig({ apiKey: "sk-test", models: { pro: { id: "b" } } })),
    );
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    const msg = formatInvalidConfigError(report);
    expect(msg).toMatch(/errors and can't be used/);
    expect(msg).toMatch(/missing: lite, max/);
    expect(msg).not.toMatch(/apiKey is not set/);
  });
});
