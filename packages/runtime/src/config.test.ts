import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDangerousBash, loadSettings, parseSettings, settingsSchema } from "./config.js";

describe("settingsSchema", () => {
  it("applies defaults when empty input is given", () => {
    const s = parseSettings({});
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.maxTokens).toBe(8192);
    expect(s.maxTurns).toBe(40);
    expect(s.permissions.defaultEffect).toBe("ask");
    expect(s.permissions.rules).toEqual([]);
    expect(s.transcript.enabled).toBe(true);
    expect(s.slash.enabled).toBe(true);
    expect(s.slash.projectDirs).toBeUndefined();
    expect(s.slash.userPaths).toBeUndefined();
  });

  it("accepts slash overrides", () => {
    const s = parseSettings({
      slash: { enabled: false, projectDirs: ["prompts"], userPaths: ["~/.my/cmds"] },
    });
    expect(s.slash.enabled).toBe(false);
    expect(s.slash.projectDirs).toEqual(["prompts"]);
    expect(s.slash.userPaths).toEqual(["~/.my/cmds"]);
  });

  it("accepts permission rules", () => {
    const s = parseSettings({
      permissions: {
        defaultEffect: "ask",
        rules: [{ tool: "bash", effect: "allow", match: { command: "ls" } }],
      },
    });
    expect(s.permissions.rules).toHaveLength(1);
    expect(s.permissions.rules[0]?.effect).toBe("allow");
  });

  it("rejects unknown effect", () => {
    expect(() =>
      settingsSchema.parse({
        permissions: { defaultEffect: "nope", rules: [] },
      }),
    ).toThrow();
  });
});

describe("loadSettings", () => {
  it("reads model, baseURL, apiKey, sessionDir from config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const path = join(dir, "nova.config.json");
    await writeFile(
      path,
      JSON.stringify({
        apiKey: "sk-test-123",
        model: "claude-haiku-4-5",
        baseURL: "https://file.example.com",
        sessionDir: "/tmp/nova-sessions",
      }),
      "utf8",
    );
    const s = await loadSettings(path);
    expect(s.apiKey).toBe("sk-test-123");
    expect(s.model).toBe("claude-haiku-4-5");
    expect(s.baseURL).toBe("https://file.example.com");
    expect(s.sessionDir).toBe("/tmp/nova-sessions");
  });

  it("falls back to defaults when config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-config-"));
    const s = await loadSettings(join(dir, "nova.config.json"));
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.baseURL).toBeUndefined();
    expect(s.apiKey).toBeUndefined();
    expect(s.sessionDir).toBeUndefined();
  });
});

describe("isDangerousBash", () => {
  it.each([
    ["rm -rf /", true],
    ["rm -rf /usr", true],
    ["rm -rf ./build", false],
    [":(){ :|:& };:", true],
    ["mkfs.ext4 /dev/sda1", true],
    ["dd if=/dev/zero of=/dev/sda", true],
    ["ls -la", false],
    ["echo hello", false],
  ])("classifies %s -> %s", (cmd, expected) => {
    expect(isDangerousBash(cmd)).toBe(expected);
  });
});
