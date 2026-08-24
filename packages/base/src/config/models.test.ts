import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, parseSettings, saveModelProfileOverride } from "./config.js";
import {
  AUTO_WRITTEN_MODEL_TABLES,
  BUILTIN_PROVIDER_MODELS,
  builtinModelsFor,
  stripDefaultModels,
} from "./models.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nova-models-"));
  configPath = join(dir, "nova.config.json");
});

const write = (raw: unknown) => writeFile(configPath, JSON.stringify(raw), "utf8");
const readRaw = async () =>
  JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

describe("built-in model tables", () => {
  it("fills the tier ladder from the provider, so the config file needn't carry it", () => {
    const s = parseSettings({
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/anthropic",
    });
    expect(Object.keys(s.models).sort()).toEqual(["lite", "max", "pro"]);
    expect(s.models.lite?.id).toBe("deepseek-v4-flash-vision-exp");
    expect(s.models.pro?.id).toBe("deepseek-v4-pro");
    // The default `model` tier resolves against the filled table, so a config
    // carrying nothing but provider + key is complete.
    expect(s.model).toBe("pro");
  });

  it("keeps an unconfigured (provider-less) config empty so setup still runs", () => {
    expect(parseSettings({}).models).toEqual({});
  });

  it("leaves a provider with no built-in table to spell out its own ladder", () => {
    const models = { lite: { id: "a" }, pro: { id: "b" }, max: { id: "c" } };
    const s = parseSettings({ provider: "other", models });
    expect(s.models.pro?.id).toBe("b");
    expect(Object.keys(s.models).sort()).toEqual(["lite", "max", "pro"]);
  });

  it("merges a same-model override field-by-field over the built-in", () => {
    const s = parseSettings({ provider: "deepseek", models: { pro: { thinking: "low" } } });
    expect(s.models.pro?.thinking).toBe("low");
    // Everything not overridden still tracks the built-in.
    expect(s.models.pro?.id).toBe(BUILTIN_PROVIDER_MODELS.deepseek?.pro?.id);
    expect(s.models.pro?.pricing).toEqual(BUILTIN_PROVIDER_MODELS.deepseek?.pro?.pricing);
    expect(s.models.lite?.id).toBe("deepseek-v4-flash-vision-exp");
  });

  it("replaces (never merges) a tier that names a different model id", () => {
    const s = parseSettings({
      provider: "deepseek",
      models: { pro: { id: "my-model", maxTokens: 4096 } },
    });
    expect(s.models.pro?.id).toBe("my-model");
    expect(s.models.pro?.maxTokens).toBe(4096);
    // The built-in's price belongs to the built-in's model — not inherited.
    expect(s.models.pro?.pricing).toBeUndefined();
  });

  it("passes extra tiers through alongside the built-ins", () => {
    const s = parseSettings({ provider: "deepseek", models: { vision: { id: "v-1" } } });
    expect(s.models.vision?.id).toBe("v-1");
    expect(s.models.max?.id).toBe("deepseek-v4-pro");
  });

  it("never hands out the shared built-in objects (parses stay isolated)", () => {
    const a = parseSettings({ provider: "deepseek" });
    a.models.pro!.thinking = "off";
    expect(parseSettings({ provider: "deepseek" }).models.pro?.thinking).toBe("high");
    expect(builtinModelsFor("deepseek").pro?.thinking).toBe("high");
  });
});

describe("stripDefaultModels", () => {
  it("drops a table Nova itself wrote, leaving the rest of the config intact", async () => {
    await write({
      apiKey: "k",
      provider: "deepseek",
      model: "pro",
      models: BUILTIN_PROVIDER_MODELS.deepseek,
    });
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    expect(raw.models).toBeUndefined();
    expect(raw.apiKey).toBe("k");
    // Value-preserving: the stripped table comes straight back on load.
    const s = await loadSettings(configPath);
    expect(s.models.pro?.id).toBe("deepseek-v4-pro");
  });

  it("drops the decimal-magnitude table older versions wrote, so binary window sizes land", async () => {
    // Every superseded table stays a snapshot; a config carrying one is still
    // Nova's own writing, not a hand-tuned window size to be pinned forever.
    const legacy = AUTO_WRITTEN_MODEL_TABLES.deepseek?.at(-1);
    expect(legacy?.pro?.contextWindowSize).toBe(1_000_000);
    await write({ provider: "deepseek", models: legacy });
    expect(await stripDefaultModels(configPath)).toBe(true);
    expect((await readRaw()).models).toBeUndefined();
    const s = await loadSettings(configPath);
    expect(s.models.pro?.contextWindowSize).toBe(1_048_576);
    expect(s.models.pro?.maxTokens).toBe(393_216);
  });

  it("reduces a table that drifted by one field to just that override", async () => {
    // What older versions produced: /effort persisted the whole table to change
    // one thinking level, so most real configs differ by a field or two.
    const deepseek = BUILTIN_PROVIDER_MODELS.deepseek!;
    await write({
      provider: "deepseek",
      models: { ...deepseek, lite: { ...deepseek.lite!, thinking: "high" } },
    });
    expect(await stripDefaultModels(configPath)).toBe(true);
    expect((await readRaw()).models).toEqual({ lite: { thinking: "high" } });
    // The user's choice survives; everything else is back on the built-ins.
    const s = await loadSettings(configPath);
    expect(s.models.lite?.thinking).toBe("high");
    expect(s.models.lite?.id).toBe("deepseek-v4-flash-vision-exp");
    expect(s.models.lite?.pricing).toEqual(deepseek.lite?.pricing);
    expect(s.models.pro?.thinking).toBe("high");
  });

  it("keeps a re-pointed tier verbatim, since it can't inherit the built-in", async () => {
    const deepseek = BUILTIN_PROVIDER_MODELS.deepseek!;
    await write({
      provider: "deepseek",
      models: { ...deepseek, pro: { ...deepseek.pro!, id: "deepseek-reasoner" } },
    });
    expect(await stripDefaultModels(configPath)).toBe(true);
    expect((await readRaw()).models).toEqual({
      pro: { ...deepseek.pro, id: "deepseek-reasoner" },
    });
    const s = await loadSettings(configPath);
    expect(s.models.pro?.id).toBe("deepseek-reasoner");
    expect(s.models.lite?.id).toBe("deepseek-v4-flash-vision-exp");
  });

  it("is idempotent — an already-reduced table is left alone", async () => {
    await write({ provider: "deepseek", models: { lite: { thinking: "high" } } });
    expect(await stripDefaultModels(configPath)).toBe(false);
    expect((await readRaw()).models).toEqual({ lite: { thinking: "high" } });
  });

  it("is a no-op for a missing, table-less, or unknown-provider config", async () => {
    expect(await stripDefaultModels(configPath)).toBe(false);
    await write({ provider: "deepseek", apiKey: "k" });
    expect(await stripDefaultModels(configPath)).toBe(false);
    await write({ provider: "other", models: BUILTIN_PROVIDER_MODELS.deepseek });
    expect(await stripDefaultModels(configPath)).toBe(false);
  });
});

describe("saveModelProfileOverride", () => {
  it("persists only the changed field, not the resolved table", async () => {
    await write({ apiKey: "k", provider: "deepseek", model: "pro" });
    await saveModelProfileOverride("pro", { thinking: "low" }, configPath);
    expect((await readRaw()).models).toEqual({ pro: { thinking: "low" } });
    const s = await loadSettings(configPath);
    expect(s.models.pro?.thinking).toBe("low");
    expect(s.models.pro?.id).toBe("deepseek-v4-pro");
  });

  it("merges into an existing override without touching sibling tiers", async () => {
    await write({
      provider: "deepseek",
      models: { lite: { thinking: "off" }, pro: { maxTokens: 8192 } },
    });
    await saveModelProfileOverride("pro", { thinking: "medium" }, configPath);
    expect((await readRaw()).models).toEqual({
      lite: { thinking: "off" },
      pro: { maxTokens: 8192, thinking: "medium" },
    });
  });
});
