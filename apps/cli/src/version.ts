import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI's own npm identity, read from the bundled package.json at runtime. */
export interface CliPackage {
  name: string;
  version: string;
}

/**
 * Read the CLI's `name` and `version` from its package.json (the single source
 * of truth — always in sync with what's installed). Falls back to safe defaults
 * if the file can't be read.
 */
export async function readCliPackage(): Promise<CliPackage> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, "../package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return { name: pkg.name ?? "@asathinkeroops/nova-code", version: pkg.version ?? "0.0.0" };
  } catch {
    return { name: "@asathinkeroops/nova-code", version: "0.0.0" };
  }
}

/** The CLI's version from its package.json, or "0.0.0" if it can't be read. */
export async function readCliVersion(): Promise<string> {
  return (await readCliPackage()).version;
}
