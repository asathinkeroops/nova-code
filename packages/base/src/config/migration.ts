import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const LEGACY_PROVIDER_KEYS = ["provider", "baseURL", "apiKey", "models", "transport"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasLegacyProviderField(raw: Record<string, unknown>): boolean {
  return LEGACY_PROVIDER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

/**
 * Convert the removed flat provider fields into one provider entry. This is a
 * one-time RAW-config adapter, not a second runtime settings shape: callers
 * persist the returned object and then parse it with the new-only schema.
 *
 * When a non-empty `providers` array already exists, it is authoritative and
 * stale top-level provider fields are only removed. A malformed non-array
 * `providers` value is left untouched so schema validation can report it rather
 * than migration silently replacing user data.
 *
 * Returns the original reference when no adaptation is needed.
 */
export function adaptLegacyProviderConfig(raw: unknown): unknown {
  if (!isPlainObject(raw) || !hasLegacyProviderField(raw)) return raw;

  const existingProviders = raw["providers"];
  if (existingProviders !== undefined && !Array.isArray(existingProviders)) return raw;

  const next: Record<string, unknown> = { ...raw };
  if (!Array.isArray(existingProviders) || existingProviders.length === 0) {
    const legacyProfile =
      typeof raw["provider"] === "string" && raw["provider"].trim()
        ? raw["provider"].trim()
        : "deepseek";
    const entry: Record<string, unknown> = {
      name: legacyProfile,
      profile: legacyProfile,
    };
    for (const key of ["baseURL", "apiKey", "models", "transport"] as const) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) entry[key] = raw[key];
    }
    next["providers"] = [entry];
    next["currentProvider"] = legacyProfile;
  }

  for (const key of LEGACY_PROVIDER_KEYS) delete next[key];
  return next;
}

/**
 * Atomically adapt an on-disk legacy config to `providers/currentProvider`.
 * Missing, unreadable, malformed, or already-current files are left untouched.
 * The original file mode is preserved because the config may contain an API
 * key. Returns true only when a rewritten file was installed successfully.
 */
export async function migrateLegacyProviderConfig(configPath: string): Promise<boolean> {
  let raw: unknown;
  let mode: number;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
    mode = (await stat(configPath)).mode & 0o777;
  } catch {
    return false;
  }

  const adapted = adaptLegacyProviderConfig(raw);
  if (adapted === raw) return false;

  const dir = dirname(configPath);
  const tempPath = join(dir, `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(adapted, null, 2)}\n`, { encoding: "utf8", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, configPath);
    return true;
  } catch {
    await unlink(tempPath).catch(() => undefined);
    return false;
  }
}
