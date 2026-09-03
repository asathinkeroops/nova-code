import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activeModels, activeProvider, loadSettings } from "./config.js";
import {
  adaptLegacyProviderConfig,
  migrateLegacyProviderConfig,
} from "./migration.js";

let configPath: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "nova-config-migration-"));
  configPath = join(dir, "nova.config.json");
});

describe("adaptLegacyProviderConfig", () => {
  it("moves all removed top-level fields into one provider entry", () => {
    const raw = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-old",
      transport: "openai",
      models: { pro: { thinking: "low" } },
      model: "pro",
      language: "zh-CN",
    };

    expect(adaptLegacyProviderConfig(raw)).toEqual({
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          baseURL: "https://api.deepseek.com",
          apiKey: "sk-old",
          transport: "openai",
          models: { pro: { thinking: "low" } },
        },
      ],
      currentProvider: "deepseek",
      model: "pro",
      language: "zh-CN",
    });
  });

  it("uses the old default profile when provider was omitted", () => {
    expect(adaptLegacyProviderConfig({ apiKey: "sk-old" })).toEqual({
      providers: [{ name: "deepseek", profile: "deepseek", apiKey: "sk-old" }],
      currentProvider: "deepseek",
    });
  });

  it("keeps an existing providers array authoritative and removes stale flat fields", () => {
    const providers = [{ name: "primary", profile: "generic", apiKey: "new-key" }];
    expect(
      adaptLegacyProviderConfig({
        providers,
        currentProvider: "primary",
        provider: "deepseek",
        apiKey: "stale-key",
      }),
    ).toEqual({ providers, currentProvider: "primary" });
  });

  it("leaves current configs and malformed providers values untouched", () => {
    const current = { providers: [{ name: "deepseek" }], currentProvider: "deepseek" };
    const malformed = { providers: "broken", provider: "deepseek" };
    expect(adaptLegacyProviderConfig(current)).toBe(current);
    expect(adaptLegacyProviderConfig(malformed)).toBe(malformed);
  });
});

describe("migrateLegacyProviderConfig", () => {
  it("rewrites the file once, preserves permissions, and produces loadable settings", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        provider: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-old",
        transport: "openai",
        model: "pro",
      }),
      "utf8",
    );
    await chmod(configPath, 0o600);

    expect(await migrateLegacyProviderConfig(configPath)).toBe(true);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(raw["provider"]).toBeUndefined();
    expect(raw["apiKey"]).toBeUndefined();

    const settings = await loadSettings(configPath);
    expect(activeProvider(settings)).toMatchObject({
      name: "deepseek",
      profile: "deepseek",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-old",
      transport: "openai",
    });
    expect(activeModels(settings).pro?.id).toBe("deepseek-v4-pro");
    expect(await migrateLegacyProviderConfig(configPath)).toBe(false);
  });

  it("does not rewrite malformed JSON", async () => {
    await writeFile(configPath, "{ invalid", "utf8");
    expect(await migrateLegacyProviderConfig(configPath)).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe("{ invalid");
  });
});
