import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePath, settingsSchema, type Settings } from "@nova/runtime";
import { describe, expect, it } from "vitest";
import { isWorkspaceTrusted, trustWorkspace } from "./workspace-trust.js";

function settings(patch?: Partial<Settings["trust"]>): Settings {
  const s = settingsSchema.parse({});
  if (patch) s.trust = { ...s.trust, ...patch };
  return s;
}

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "nova-trust-"));
}

describe("isWorkspaceTrusted", () => {
  it("returns true when the feature is disabled", async () => {
    const ws = fixture();
    expect(await isWorkspaceTrusted(settings({ enabled: false }), ws)).toBe(true);
  });

  it("returns false for an untrusted workspace with no roots", async () => {
    const ws = fixture();
    expect(await isWorkspaceTrusted(settings(), ws)).toBe(false);
  });

  it("trusts a workspace equal to a recorded root", async () => {
    const ws = fixture();
    expect(await isWorkspaceTrusted(settings({ trustedRoots: [ws] }), ws)).toBe(true);
  });

  it("trusts a subdirectory of a recorded root", async () => {
    const root = fixture();
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(await isWorkspaceTrusted(settings({ trustedRoots: [root] }), sub)).toBe(true);
  });

  it("does not trust a sibling outside every root", async () => {
    const root = fixture();
    const other = fixture();
    expect(await isWorkspaceTrusted(settings({ trustedRoots: [root] }), other)).toBe(false);
  });
});

describe("trustWorkspace", () => {
  it("appends the canonical workspace and persists it to the config", async () => {
    const ws = fixture();
    const configPath = join(fixture(), "nova.config.json");
    const s = settings();

    await trustWorkspace(s, ws, configPath);

    const wsCanon = await canonicalizePath(ws, ".");
    expect(s.trust.trustedRoots).toContain(wsCanon);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.trust.trustedRoots).toContain(wsCanon);
  });

  it("is idempotent — no duplicate root when already trusted", async () => {
    const ws = fixture();
    const wsCanon = await canonicalizePath(ws, ".");
    const configPath = join(fixture(), "nova.config.json");
    const s = settings({ trustedRoots: [wsCanon] });

    await trustWorkspace(s, ws, configPath);

    expect(s.trust.trustedRoots.filter((r) => r === wsCanon)).toHaveLength(1);
  });

  it("trusts the home directory for the session only, without writing to disk", async () => {
    const configPath = join(fixture(), "nova.config.json");
    const s = settings();

    await trustWorkspace(s, homedir(), configPath);

    const homeCanon = await canonicalizePath(homedir(), ".");
    expect(s.trust.trustedRoots).toContain(homeCanon);
    expect(existsSync(configPath)).toBe(false);
  });
});
