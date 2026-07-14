import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  diagnoseConfig,
  formatDoctorReport,
  formatInvalidConfigError,
  summarizeReport,
} from "./doctor.js";

/** A minimal, fully-valid config: apiKey + all required tiers + a valid active model. */
const VALID_CONFIG = {
  apiKey: "sk-test",
  model: "pro",
  models: {
    lite: { id: "lite-id", contextWindowSize: 200000, maxTokens: 8192 },
    pro: { id: "pro-id", contextWindowSize: 200000, maxTokens: 8192 },
    max: { id: "max-id", contextWindowSize: 200000, maxTokens: 8192 },
  },
};

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-doctor-"));
  const path = join(dir, "nova.config.json");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("diagnoseConfig", () => {
  it("treats a missing file as the fresh-install state, not an error", async () => {
    const { report, settings } = await diagnoseConfig({
      configPath: join(tmpdir(), "definitely-missing-nova.json"),
    });
    expect(report.exists).toBe(false);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    // Falls back to a usable, all-defaults config.
    expect(Object.keys(settings.models)).toHaveLength(0);
  });

  it("reports invalid JSON as a hard error and falls back to defaults", async () => {
    const path = await writeConfig("{ not valid json ");
    const { report, settings } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.level).toBe("error");
    expect(report.issues[0]?.title).toMatch(/not valid JSON/);
    expect(settings.apiKey).toBeUndefined();
  });

  it("reports a missing model tier via the schema refinement", async () => {
    const bad = { ...VALID_CONFIG, models: { lite: VALID_CONFIG.models.lite, pro: VALID_CONFIG.models.pro } };
    const path = await writeConfig(JSON.stringify(bad));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.level === "error" && i.title.includes("models"))).toBe(true);
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
    expect(settings.apiKey).toBe("sk-test");
  });

  it("warns when no apiKey is configured", async () => {
    const path = await writeConfig(JSON.stringify({ model: "pro", models: VALID_CONFIG.models }));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes("no apiKey"));
    expect(warn?.level).toBe("warn");
  });

  it("warns when an apiKey is set but the models table is empty", async () => {
    const path = await writeConfig(JSON.stringify({ apiKey: "sk-test" }));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes("no models are configured"));
    expect(warn?.level).toBe("warn");
  });

  it("warns when provider is not a built-in profile (falls back to `other`)", async () => {
    const path = await writeConfig(JSON.stringify({ ...VALID_CONFIG, provider: "deepsek" }));
    const { report } = await diagnoseConfig({ configPath: path });
    // A free-form provider id is schema-valid — it just resolves to `other`.
    expect(report.valid).toBe(true);
    const warn = report.issues.find((i) => i.title.includes('provider "deepsek"'));
    expect(warn?.level).toBe("warn");
  });

  it("does not warn for a built-in provider id", async () => {
    const path = await writeConfig(JSON.stringify({ ...VALID_CONFIG, provider: "other" }));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.title.includes("provider"))).toBe(false);
  });
});

describe("report formatting", () => {
  it("summarizes error and warning counts", async () => {
    const path = await writeConfig(JSON.stringify({ apiKey: "sk-test" }));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(summarizeReport(report)).toBe("0 errors, 1 warning");
  });

  it("gives a clean bill of health for a valid config", async () => {
    const path = await writeConfig(JSON.stringify(VALID_CONFIG));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(formatDoctorReport(report)).toMatch(/looks good/);
  });

  it("builds a fix prompt that lists the issues and preserves the apiKey", async () => {
    const path = await writeConfig(JSON.stringify({ apiKey: "sk-test", model: "pro", models: { pro: { id: "b" } } }));
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
    const path = await writeConfig(JSON.stringify({ apiKey: "sk-test", model: "pro", models: { pro: { id: "b" } } }));
    const { report } = await diagnoseConfig({ configPath: path });
    expect(report.valid).toBe(false);
    const msg = formatInvalidConfigError(report);
    expect(msg).toMatch(/errors and can't be used/);
    expect(msg).toMatch(/missing: lite, max/);
    expect(msg).not.toMatch(/apiKey is not set/);
  });
});
