import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeModels,
  loadSettings,
  parseSettings,
  saveModelProfileOverride,
} from "./config.js";
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
const providerConfig = (
  profile: string,
  entry: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) => ({
  providers: [{ name: profile, profile, ...entry }],
  currentProvider: profile,
  ...settings,
});

describe("built-in model tables", () => {
  it("fills the tier ladder from the provider, so the config file needn't carry it", () => {
    const s = parseSettings({
      ...providerConfig("deepseek", { baseURL: "https://api.deepseek.com/anthropic" }),
    });
    expect(Object.keys(activeModels(s)).sort()).toEqual(["lite", "max", "pro"]);
    expect(activeModels(s).lite?.id).toBe("deepseek-v4-flash-vision-exp");
    expect(activeModels(s).pro?.id).toBe("deepseek-v4-pro");
    // The default `model` tier resolves against the filled table, so a config
    // carrying nothing but provider + key is complete.
    expect(s.model).toBe("pro");
  });

  it("keeps an unconfigured (provider-less) config empty so setup still runs", () => {
    expect(activeModels(parseSettings({}))).toEqual({});
  });

  it("leaves a provider with no built-in table to spell out its own ladder", () => {
    const models = { lite: { id: "a" }, pro: { id: "b" }, max: { id: "c" } };
    const s = parseSettings(providerConfig("other", { models }));
    expect(activeModels(s).pro?.id).toBe("b");
    expect(Object.keys(activeModels(s)).sort()).toEqual(["lite", "max", "pro"]);
  });

  it("merges a same-model override field-by-field over the built-in", () => {
    const s = parseSettings(providerConfig("deepseek", { models: { pro: { thinking: "low" } } }));
    expect(activeModels(s).pro?.thinking).toBe("low");
    // Everything not overridden still tracks the built-in.
    expect(activeModels(s).pro?.id).toBe(BUILTIN_PROVIDER_MODELS.deepseek?.pro?.id);
    expect(activeModels(s).pro?.pricing).toEqual(BUILTIN_PROVIDER_MODELS.deepseek?.pro?.pricing);
    expect(activeModels(s).lite?.id).toBe("deepseek-v4-flash-vision-exp");
  });

  it("replaces (never merges) a tier that names a different model id", () => {
    const s = parseSettings(
      providerConfig("deepseek", { models: { pro: { id: "my-model", maxTokens: 4096 } } }),
    );
    expect(activeModels(s).pro?.id).toBe("my-model");
    expect(activeModels(s).pro?.maxTokens).toBe(4096);
    // The built-in's price belongs to the built-in's model — not inherited.
    expect(activeModels(s).pro?.pricing).toBeUndefined();
  });

  it("passes extra tiers through alongside the built-ins", () => {
    const s = parseSettings(providerConfig("deepseek", { models: { vision: { id: "v-1" } } }));
    expect(activeModels(s).vision?.id).toBe("v-1");
    expect(activeModels(s).max?.id).toBe("deepseek-v4-pro");
  });

  it("never hands out the shared built-in objects (parses stay isolated)", () => {
    const a = parseSettings(providerConfig("deepseek"));
    activeModels(a).pro!.thinking = "off";
    expect(activeModels(parseSettings(providerConfig("deepseek"))).pro?.thinking).toBe("high");
    expect(builtinModelsFor("deepseek").pro?.thinking).toBe("high");
  });
});

describe("stripDefaultModels", () => {
  it("drops a table Nova itself wrote, leaving the rest of the config intact", async () => {
    await write(
      providerConfig(
        "deepseek",
        { apiKey: "k", models: BUILTIN_PROVIDER_MODELS.deepseek },
        { model: "pro" },
      ),
    );
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    const entry = (raw.providers as Record<string, unknown>[])[0];
    expect(entry?.models).toBeUndefined();
    expect(entry?.apiKey).toBe("k");
    // Value-preserving: the stripped table comes straight back on load.
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.id).toBe("deepseek-v4-pro");
  });

  it("drops the decimal-magnitude table older versions wrote, so binary window sizes land", async () => {
    // Every superseded table stays a snapshot; a config carrying one is still
    // Nova's own writing, not a hand-tuned window size to be pinned forever.
    const legacy = AUTO_WRITTEN_MODEL_TABLES.deepseek?.at(-1);
    expect(legacy?.pro?.contextWindowSize).toBe(1_000_000);
    await write(providerConfig("deepseek", { models: legacy }));
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toBeUndefined();
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.contextWindowSize).toBe(1_048_576);
    expect(activeModels(s).pro?.maxTokens).toBe(393_216);
  });

  it("reduces a table that drifted by one field to just that override", async () => {
    // What older versions produced: /effort persisted the whole table to change
    // one thinking level, so most real configs differ by a field or two.
    const deepseek = BUILTIN_PROVIDER_MODELS.deepseek!;
    await write(
      providerConfig("deepseek", {
        models: { ...deepseek, lite: { ...deepseek.lite!, thinking: "high" } },
      }),
    );
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      lite: { thinking: "high" },
    });
    // The user's choice survives; everything else is back on the built-ins.
    const s = await loadSettings(configPath);
    expect(activeModels(s).lite?.thinking).toBe("high");
    expect(activeModels(s).lite?.id).toBe("deepseek-v4-flash-vision-exp");
    expect(activeModels(s).lite?.pricing).toEqual(deepseek.lite?.pricing);
    expect(activeModels(s).pro?.thinking).toBe("high");
  });

  it("keeps a re-pointed tier verbatim, since it can't inherit the built-in", async () => {
    const deepseek = BUILTIN_PROVIDER_MODELS.deepseek!;
    await write(
      providerConfig("deepseek", {
        models: { ...deepseek, pro: { ...deepseek.pro!, id: "deepseek-reasoner" } },
      }),
    );
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      pro: { ...deepseek.pro, id: "deepseek-reasoner" },
    });
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.id).toBe("deepseek-reasoner");
    expect(activeModels(s).lite?.id).toBe("deepseek-v4-flash-vision-exp");
  });

  it("is idempotent — an already-reduced table is left alone", async () => {
    await write(providerConfig("deepseek", { models: { lite: { thinking: "high" } } }));
    expect(await stripDefaultModels(configPath)).toBe(false);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      lite: { thinking: "high" },
    });
  });

  it("is a no-op for a missing, table-less, or unknown-provider config", async () => {
    expect(await stripDefaultModels(configPath)).toBe(false);
    await write(providerConfig("deepseek", { apiKey: "k" }));
    expect(await stripDefaultModels(configPath)).toBe(false);
    await write(providerConfig("other", { models: BUILTIN_PROVIDER_MODELS.deepseek }));
    expect(await stripDefaultModels(configPath)).toBe(false);
  });
});

describe("saveModelProfileOverride", () => {
  it("persists only the changed field, not the resolved table", async () => {
    await write(providerConfig("deepseek", { apiKey: "k" }, { model: "pro" }));
    await saveModelProfileOverride("pro", { thinking: "low" }, configPath);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      pro: { thinking: "low" },
    });
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.thinking).toBe("low");
    expect(activeModels(s).pro?.id).toBe("deepseek-v4-pro");
  });

  it("merges into an existing override without touching sibling tiers", async () => {
    await write(
      providerConfig("deepseek", {
        models: { lite: { thinking: "off" }, pro: { maxTokens: 8192 } },
      }),
    );
    await saveModelProfileOverride("pro", { thinking: "medium" }, configPath);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      lite: { thinking: "off" },
      pro: { maxTokens: 8192, thinking: "medium" },
    });
  });
});

describe("providers array structure", () => {
  it("merges built-ins into each provider entry by profile", () => {
    const s = parseSettings({
      providers: [
        {
          name: "a",
          profile: "deepseek",
          baseURL: "https://a",
          apiKey: "k",
          models: { pro: { thinking: "low" } },
        },
      ],
      currentProvider: "a",
    });
    expect(Object.keys(activeModels(s)).sort()).toEqual(["lite", "max", "pro"]);
    expect(activeModels(s).lite?.id).toBe("deepseek-v4-flash-vision-exp");
    expect(activeModels(s).pro?.thinking).toBe("low");
    expect(activeModels(s).pro?.id).toBe(BUILTIN_PROVIDER_MODELS.deepseek?.pro?.id);
  });

  it("strips default model tables written into a providers entry", async () => {
    await write({
      currentProvider: "deepseek",
      providers: [
        { name: "deepseek", profile: "deepseek", models: BUILTIN_PROVIDER_MODELS.deepseek },
      ],
    });
    expect(await stripDefaultModels(configPath)).toBe(true);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toBeUndefined();
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.id).toBe("deepseek-v4-pro");
  });

  it("persists a tier override into the active provider's entry", async () => {
    await write({
      currentProvider: "deepseek",
      providers: [{ name: "deepseek", profile: "deepseek", apiKey: "k" }],
    });
    await saveModelProfileOverride("pro", { thinking: "low" }, configPath);
    const raw = await readRaw();
    expect((raw.providers as Record<string, unknown>[])[0]?.models).toEqual({
      pro: { thinking: "low" },
    });
    const s = await loadSettings(configPath);
    expect(activeModels(s).pro?.thinking).toBe("low");
    expect(activeModels(s).pro?.id).toBe("deepseek-v4-pro");
  });

  it("refuses to save an override when currentProvider does not exist", async () => {
    const original = {
      currentProvider: "missing",
      providers: [{ name: "deepseek", profile: "deepseek", apiKey: "k" }],
    };
    await write(original);

    await expect(saveModelProfileOverride("pro", { thinking: "low" }, configPath)).rejects.toThrow(
      /currentProvider "missing" does not name a configured provider/,
    );
    expect(await readRaw()).toEqual(original);
  });
});
