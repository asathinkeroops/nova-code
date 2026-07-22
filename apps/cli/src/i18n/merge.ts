/**
 * Deep-merge helpers for the i18n catalogs. The English catalog (`en`) is the
 * canonical shape; a locale catalog (e.g. `zh`) is a deep-partial that overrides
 * only the keys it provides. Anything it omits falls back to English.
 *
 * Values are either plain strings or `(params) => string` functions. Functions
 * (and strings) are leaf values — a locale simply replaces the whole leaf; we
 * never merge *into* a function. We recurse only through plain objects.
 */

/**
 * A recursively-optional view of a catalog: every leaf may be omitted. Functions
 * and arrays are leaves — a locale replaces the whole value, never merges into it
 * (an array like a word-list is translated as a unit).
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends readonly unknown[]
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Return a new object that is `base` with `override`'s leaves applied on top,
 * recursing through nested plain objects. `base` and `override` are never
 * mutated. A leaf present in `override` wins; a leaf absent from `override`
 * keeps `base`'s value (the English fallback).
 */
export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const o = (override as Record<string, unknown>)[key];
    if (o === undefined) continue;
    const b = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o;
  }
  return out as T;
}
