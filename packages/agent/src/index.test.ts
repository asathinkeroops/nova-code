import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const entry = readFileSync(join(here, "index.ts"), "utf8");

/**
 * The entry point is the package's API surface, so the two rules that keep it
 * from silently growing back are worth pinning down rather than only writing in
 * a comment.
 */
describe("package entry point", () => {
  it("forwards nothing from @nova/core — one symbol, one import path", () => {
    // `Agent`, `Compactor`, the hook types and the rest belong to core. A
    // re-export here would make them reachable two ways and hide their owner;
    // consumers import them from @nova/core directly.
    expect(entry).not.toMatch(/export\s*\{[^}]*\}\s*from\s*"@nova\/core"/);
    expect(entry).not.toMatch(/export\s+\*\s+from\s*"@nova\/core"/);
  });

  it("keeps the port implementations behind the assembly entry points", () => {
    // ports.ts builds the objects `assembleAgent` hands to `createAgent`. A host
    // reaches them by calling assembleSession / assembleAgent, never by wiring a
    // container itself — exporting the factories would invite the latter.
    expect(entry).not.toMatch(/from\s*"\.\/ports\.js"/);
    expect(entry).toMatch(/export\s*\{\s*assembleSession\s*\}/);
  });
});
