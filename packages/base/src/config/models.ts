import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelProfile } from "./config.js";

/**
 * DeepSeek's built-in performance tiers. Three fixed rungs — lite / pro / max:
 * `lite` maps to the cheap vision-capable `deepseek-v4-flash-vision-exp`; `pro`
 * and `max` share the capable `deepseek-v4-pro` id and differ only in reasoning
 * depth via the per-tier `thinking` level (low → high → max), a genuine
 * speed/cost ↔ capability ladder on the available models.
 *
 * Token magnitudes here are binary: "384K" output / "1M" context mean 384 × 1024
 * and 1024 × 1024, matching how {@link formatTokenCount} renders them in the UI.
 */
const DEEPSEEK_MODELS: Record<string, ModelProfile> = {
  lite: {
    id: "deepseek-v4-flash-vision-exp",
    maxTokens: 393_216, // 384 KiB-tokens
    contextWindowSize: 1_048_576, // 1 MiB-tokens
    thinking: "low",
    modalities: { input: ["text", "image"] },
    // CNY per 1M tokens; `input` is cache-miss, `cacheRead` cache-hit.
    pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" },
  },
  pro: {
    id: "deepseek-v4-pro",
    maxTokens: 393_216,
    contextWindowSize: 1_048_576,
    thinking: "high",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
  max: {
    id: "deepseek-v4-pro",
    maxTokens: 393_216,
    contextWindowSize: 1_048_576,
    thinking: "max",
    modalities: { input: ["text"] },
    // Same concrete id as `pro`, so same list price.
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
};

/**
 * Moonshot (Kimi) tiers. All three rungs run 256K-context / 256K-output code
 * models. `lite` maps to `kimi-k2.5` with thinking off (fast & cheap); `pro` and
 * `max` map to the always-thinking code models `kimi-k2.7-code-highspeed` and
 * `kimi-k2.7-code` — same 256K envelope, `max` trading speed for the full model.
 * The per-tier `thinking` level here is what the Moonshot profile reads to shape
 * the `thinking: { type, keep }` knob (see providers/moonshot.ts).
 *
 * "256K" is binary here too — 256 × 1024 — same convention as the DeepSeek table.
 */
const MOONSHOT_MODELS: Record<string, ModelProfile> = {
  lite: {
    id: "kimi-k2.5",
    maxTokens: 262_144, // 256 KiB-tokens
    contextWindowSize: 262_144,
    thinking: "off",
    modalities: { input: ["text"] },
    // CNY per 1M tokens; `input` is cache-miss, `cacheRead` cache-hit.
    pricing: { input: 4, output: 21, cacheRead: 0.7, cacheWrite: 4, currency: "CNY" },
  },
  pro: {
    id: "kimi-k2.7-code-highspeed",
    maxTokens: 262_144,
    contextWindowSize: 262_144,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 13, output: 54, cacheRead: 2.6, cacheWrite: 13, currency: "CNY" },
  },
  max: {
    id: "kimi-k2.7-code",
    maxTokens: 262_144,
    contextWindowSize: 262_144,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 6.5, currency: "CNY" },
  },
};

/**
 * The tier tables as they shipped before the lite tier moved to
 * `deepseek-v4-flash-vision-exp` (binary magnitudes). Frozen — see
 * {@link AUTO_WRITTEN_MODEL_TABLES}: a config still carrying this table was
 * written by Nova, not hand-tuned, and must reduce away rather than pin the
 * install to the old id.
 */
const DEEPSEEK_MODELS_FLASH: Record<string, ModelProfile> = {
  lite: {
    id: "deepseek-v4-flash",
    maxTokens: 393_216,
    contextWindowSize: 1_048_576,
    thinking: "low",
    modalities: { input: ["text"] },
    pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" },
  },
  pro: {
    id: "deepseek-v4-pro",
    maxTokens: 393_216,
    contextWindowSize: 1_048_576,
    thinking: "high",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
  max: {
    id: "deepseek-v4-pro",
    maxTokens: 393_216,
    contextWindowSize: 1_048_576,
    thinking: "max",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
};

/**
 * The tier tables as CLI ≤ 0.2.5 wrote them, when token magnitudes were decimal
 * (1M = 1_000_000, 256K = 256_000). Frozen — see {@link AUTO_WRITTEN_MODEL_TABLES}:
 * a config still carrying these values was written by Nova, not hand-tuned, and
 * must reduce away rather than pin the install to the old numbers.
 */
const DEEPSEEK_MODELS_DECIMAL: Record<string, ModelProfile> = {
  lite: {
    id: "deepseek-v4-flash",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "low",
    modalities: { input: ["text"] },
    pricing: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1, currency: "CNY" },
  },
  pro: {
    id: "deepseek-v4-pro",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "high",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
  max: {
    id: "deepseek-v4-pro",
    maxTokens: 384_000,
    contextWindowSize: 1_000_000,
    thinking: "max",
    modalities: { input: ["text"] },
    pricing: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3, currency: "CNY" },
  },
};

const MOONSHOT_MODELS_DECIMAL: Record<string, ModelProfile> = {
  lite: {
    id: "kimi-k2.5",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "off",
    modalities: { input: ["text"] },
    pricing: { input: 4, output: 21, cacheRead: 0.7, cacheWrite: 4, currency: "CNY" },
  },
  pro: {
    id: "kimi-k2.7-code-highspeed",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 13, output: 54, cacheRead: 2.6, cacheWrite: 13, currency: "CNY" },
  },
  max: {
    id: "kimi-k2.7-code",
    maxTokens: 256_000,
    contextWindowSize: 256_000,
    thinking: "max",
    modalities: { input: ["text", "image"] },
    pricing: { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 6.5, currency: "CNY" },
  },
};

/**
 * Built-in tier tables, keyed by `settings.provider`. These are the DEFAULTS,
 * and they are deliberately NOT written into `nova.config.json` — they are
 * layered in at parse time (see {@link mergeBuiltinModels}) so that shipping a
 * better/cheaper model id, a corrected price, or a bigger context window reaches
 * every existing install on upgrade instead of being frozen in whatever the
 * setup wizard once wrote to disk.
 *
 * A provider with no entry here (e.g. the generic `other`) has no defaults, so
 * its config must spell out the full `lite`/`pro`/`max` ladder itself.
 */
export const BUILTIN_PROVIDER_MODELS: Record<string, Record<string, ModelProfile>> = {
  deepseek: DEEPSEEK_MODELS,
  moonshot: MOONSHOT_MODELS,
};

/**
 * The tier tables Nova has ever written into a user's `nova.config.json` (older
 * versions persisted the whole table at setup), newest first per provider. Used
 * ONLY by {@link stripDefaultModels}, to tell which parts of a table on disk
 * Nova wrote itself (droppable) from the parts the user chose (kept), so the
 * install starts tracking the built-ins again for everything it never chose.
 *
 * When a table in {@link BUILTIN_PROVIDER_MODELS} changes, DO NOT drop the old
 * literal — append a frozen copy of it here. A config still carrying that older
 * table (an install that skipped the release which cleaned it up) is otherwise
 * indistinguishable from a hand-tuned one, and would be pinned to it forever.
 */
export const AUTO_WRITTEN_MODEL_TABLES: Record<string, Record<string, ModelProfile>[]> = {
  // Current table first, then the flash-era one, then the decimal-magnitude one
  // the setup wizard wrote verbatim up to CLI 0.2.5.
  deepseek: [DEEPSEEK_MODELS, DEEPSEEK_MODELS_FLASH, DEEPSEEK_MODELS_DECIMAL],
  moonshot: [MOONSHOT_MODELS, MOONSHOT_MODELS_DECIMAL],
};

/** The built-in tier table for a provider, or undefined when it has none. */
export function builtinModelsFor(provider: string | undefined): Record<string, ModelProfile> {
  const table = provider ? BUILTIN_PROVIDER_MODELS[provider] : undefined;
  return table ? structuredClone(table) : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Layer a config's `models` table on top of its provider's built-in defaults.
 * Runs as a pre-parse step on the RAW config object (see `settingsSchema`), so
 * an entry that only carries an override (`{ "pro": { "thinking": "low" } }`)
 * still satisfies the schema's `id` requirement and the lite/pro/max ladder.
 *
 * Rules:
 * - Only applies when the config names a `provider` explicitly. A keyless config
 *   is the pre-setup state, and `models: {}` there is what tells setup (and
 *   `nova doctor`) that the install is unconfigured — filling it in would make
 *   an install with no endpoint and no key look ready.
 * - A tier that keeps the built-in `id` (or omits `id`) is MERGED field-by-field
 *   over the built-in, so a config can override one knob and inherit the rest.
 *   The flip side: it cannot UNSET a built-in field (an omitted `pricing` is
 *   re-supplied); opting out of a built-in means naming a different `id`.
 * - A tier that names a DIFFERENT `id` REPLACES the built-in outright: it is a
 *   different model, so inheriting the built-in's price/limits would be wrong.
 * - Extra tiers a provider doesn't ship are passed through untouched.
 */
export function mergeBuiltinModels(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const provider = typeof raw["provider"] === "string" ? raw["provider"].trim() : "";
  const builtin = provider ? BUILTIN_PROVIDER_MODELS[provider] : undefined;
  if (!builtin) return raw;
  const user = isPlainObject(raw["models"]) ? raw["models"] : {};
  const models: Record<string, unknown> = structuredClone(builtin);
  for (const [tier, entry] of Object.entries(user)) {
    const base = models[tier];
    if (!isPlainObject(entry) || !isPlainObject(base)) {
      models[tier] = entry;
      continue;
    }
    const id = entry["id"];
    models[tier] = id === undefined || id === base["id"] ? { ...base, ...entry } : entry;
  }
  return { ...raw, models };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isPlainObject(a) || !isPlainObject(b)) {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  );
}

/**
 * Reduce one on-disk tier table to just what it changes about `snapshot` (a
 * table Nova once wrote). Per tier:
 *
 * - Same `id` as the shipped tier → keep only the fields whose value actually
 *   differs (and drop the tier when none do). `id` itself is never kept:
 *   leaving it out is what lets the tier follow the built-in, which is the whole
 *   point. Dropping a field the entry never carried costs nothing either — a
 *   same-`id` tier inherits the built-in's fields regardless (see
 *   {@link mergeBuiltinModels}), so the effective value is the same both ways.
 * - Different `id`, or a tier the shipped table doesn't have → keep the entry
 *   verbatim. It says something the override form can't (a different model must
 *   not inherit the built-in's price/limits), so it is not ours to rewrite.
 *
 * `retained` counts the surviving fields, so a caller comparing several
 * snapshots can pick the one that explains the most of the table.
 */
function reduceToOverrides(
  user: Record<string, unknown>,
  snapshot: Record<string, ModelProfile>,
): { models: Record<string, unknown>; retained: number } {
  const models: Record<string, unknown> = {};
  let retained = 0;
  for (const [tier, entry] of Object.entries(user)) {
    const base: Record<string, unknown> | undefined = snapshot[tier];
    if (!isPlainObject(entry) || base === undefined || entry["id"] !== base["id"]) {
      models[tier] = entry;
      retained += isPlainObject(entry) ? Object.keys(entry).length : 1;
      continue;
    }
    const diff: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "id" && !deepEqual(value, base[key])) diff[key] = value;
    }
    const keys = Object.keys(diff);
    if (keys.length === 0) continue; // fully explained by the shipped table
    models[tier] = diff;
    retained += keys.length;
  }
  return { models, retained };
}

/**
 * Migration for configs written before the built-ins moved out of the file:
 * rewrite `models` down to the OVERRIDES it expresses over a table Nova itself
 * wrote (see {@link AUTO_WRITTEN_MODEL_TABLES}), dropping the key entirely when
 * nothing is left. The install then tracks {@link BUILTIN_PROVIDER_MODELS} again
 * for everything it never actually chose.
 *
 * Reducing rather than all-or-nothing matters: `/effort` used to persist the
 * whole table to change one `thinking` level, so most real configs differ from
 * the shipped table by a field or two — an exact-match check would leave nearly
 * every install pinned to the model ids and prices of the day it was set up.
 * Anything the override form can't express is kept verbatim (see
 * {@link reduceToOverrides}), so the effective settings are unchanged.
 *
 * Idempotent (an already-reduced table has no `id` to match on, so it survives
 * untouched and no write happens) and never throws — a config that can't be read
 * or rewritten simply keeps its table. Returns true when the file was rewritten.
 */
export async function stripDefaultModels(configPath: string): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!isPlainObject(parsed)) return false;
    raw = parsed;
  } catch {
    return false; // missing / unreadable / malformed — nothing to migrate.
  }
  const user = raw["models"];
  if (!isPlainObject(user)) return false;
  const provider = typeof raw["provider"] === "string" ? raw["provider"].trim() : "";
  const known = provider ? AUTO_WRITTEN_MODEL_TABLES[provider] : undefined;
  if (!known?.length) return false;
  // Several snapshots can explain a table; the one that explains the most of it
  // is the one this config was written from.
  let best = reduceToOverrides(user, known[0] as Record<string, ModelProfile>);
  for (const snapshot of known.slice(1)) {
    const next = reduceToOverrides(user, snapshot);
    if (next.retained < best.retained) best = next;
  }
  if (deepEqual(best.models, user)) return false; // nothing to strip
  const next = { ...raw };
  if (Object.keys(best.models).length === 0) delete next["models"];
  else next["models"] = best.models;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
