import { z } from "zod";

/**
 * Key-name aliases the model intermittently reaches for instead of our
 * canonical `path` field. DeepSeek (and others) frequently emit `filePath`
 * camelCase — Claude Code's own read tool names this field `file_path`, so the
 * prior is strong — which would otherwise fail schema validation purely on the
 * key name even though the value is correct. Observed live: ~40% of paginated
 * `read` calls in one session used `filePath` and every one was rejected.
 *
 * Single source of truth, shared by the schema combinator below and the CLI
 * renderer (which inspects the raw, pre-validation tool input).
 */
export const PATH_ALIASES = ["filePath", "file_path", "file"] as const;

/**
 * Wrap an object schema so it tolerates field aliases: before validation, when
 * a canonical key is absent but one of its aliases is present, the alias value
 * is copied onto the canonical key. The happy path (canonical key present) is a
 * cheap existence check that returns the input untouched — no allocation.
 *
 * Implemented as a `z.preprocess` so:
 *  - `z.infer` is unchanged (output type is the inner schema's output), and
 *  - `zodToJsonSchema` unwraps to the inner object, so the wire schema the model
 *    receives still advertises only the canonical field names. The leniency is
 *    a runtime affordance, not part of the advertised contract.
 *
 * Aliases are passed as a sibling argument rather than mutated onto field
 * instances: zod's builder methods (`.describe()`, `.optional()`, …) return
 * fresh clones, so metadata attached to a field instance would silently vanish.
 */
export function withAliases<T extends z.ZodTypeAny>(
  schema: T,
  aliases: Record<string, readonly string[]>,
): z.ZodEffects<T, z.output<T>, unknown> {
  const entries = Object.entries(aliases);
  return z.preprocess((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const obj = raw as Record<string, unknown>;
    let next: Record<string, unknown> | undefined;
    for (const [canonical, alts] of entries) {
      if (obj[canonical] !== undefined) continue;
      for (const alt of alts) {
        if (obj[alt] !== undefined) {
          next ??= { ...obj };
          next[canonical] = obj[alt];
          break;
        }
      }
    }
    return next ?? raw;
  }, schema);
}

/**
 * Resolve the effective file path from a *raw* tool input that may use a
 * `path` alias. The CLI renderer sees the unvalidated tool_use input (the
 * alias normalization happens inside the schema, downstream of rendering), so
 * it needs to mirror the same alias resolution to label the call correctly.
 */
export function aliasedPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.path === "string") return obj.path;
  for (const alt of PATH_ALIASES) {
    const v = obj[alt];
    if (typeof v === "string") return v;
  }
  return undefined;
}
