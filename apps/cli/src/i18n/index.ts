/**
 * TUI internationalization — a tiny, dependency-free, type-safe message catalog.
 *
 * Usage: `import { t } from ".../i18n/index.js"` then read `t.<area>.<key>` (or
 * `t.<area>.<key>(params)` for interpolated/pluralized entries). `t` is the
 * ACTIVE catalog: English by default, swapped to the merged Chinese catalog by
 * `setLocale` at boot (see `apps/cli/src/index.ts`). Only `zh` and `en` exist;
 * every other locale resolves to English.
 *
 * LOAD-BEARING INVARIANT — never read `t` at module top-level. ESM evaluates all
 * transitive imports before `run()` calls `setLocale`, so a value captured at
 * import time freezes to English. Read `t` inside functions/components/render
 * paths that run after boot. (This is why `t` is `export let`, reassigned by
 * `setLocale`: ESM live bindings propagate the swap to importers that read it at
 * call time — but a destructured/captured copy will not update.)
 */
import { en, type Catalog } from "./en.js";
import { zh } from "./zh.js";
import { deepMerge } from "./merge.js";

export type { Catalog } from "./en.js";

export type UiLocale = "en" | "zh";

/**
 * Map a resolved `settings.language` tag (e.g. "zh-CN", "en", "fr") to a
 * supported UI locale. Any `zh*` tag (zh, zh-CN, zh-TW, zh-Hans, …) is Chinese;
 * everything else — including undefined — is English.
 */
export function resolveUiLocale(tag: string | undefined): UiLocale {
  return tag?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let uiLocale: UiLocale = "en";

/** The active catalog. Read at call time only (see the invariant above). */
export let t: Catalog = en;

/**
 * Set the active UI locale and rebuild `t`. Pass `settings.language` and the
 * TUI-only `settings.locale` override: when `locale` is anything other than
 * "auto" it wins, otherwise the interface follows `language`. `locale` is the
 * escape hatch — it never touches the model's response language. Idempotent;
 * the boot flow calls it again after interactive setup.
 */
export function setLocale(language: string | undefined, locale: string = "auto"): void {
  const tag = locale && locale !== "auto" ? locale : language;
  uiLocale = resolveUiLocale(tag);
  t = uiLocale === "zh" ? deepMerge(en, zh) : en;
}

/** The active UI locale — for tests and diagnostics. */
export function getLocale(): UiLocale {
  return uiLocale;
}
