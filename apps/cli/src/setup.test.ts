import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeModels, activeProvider, API_KEY_ENV, parseSettings } from "@nova/base";
import type { Screen } from "./screen.js";
import { ensureSettings } from "./setup.js";

let dir: string;
let configPath: string;
const priorApiKey = process.env[API_KEY_ENV];

beforeEach(async () => {
  delete process.env[API_KEY_ENV];
  dir = await mkdtemp(join(tmpdir(), "nova-setup-"));
  configPath = join(dir, "nova.config.json");
});

afterEach(async () => {
  if (priorApiKey === undefined) delete process.env[API_KEY_ENV];
  else process.env[API_KEY_ENV] = priorApiKey;
  await rm(dir, { recursive: true, force: true });
});

describe("ensureSettings", () => {
  it("skips setup when the active providers[] entry already has an API key", async () => {
    const raw = {
      currentProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          baseURL: "https://api.deepseek.com",
          transport: "openai",
          apiKey: "sk-existing",
          models: { pro: { thinking: "low" } },
        },
      ],
      model: "pro",
    };
    await writeFile(configPath, JSON.stringify(raw), "utf8");
    const beginSetup = vi.fn();
    const screen = { beginSetup } as unknown as Screen;

    const settings = parseSettings(raw);
    const result = await ensureSettings(settings, screen, configPath);

    expect(result).toBe(settings);
    expect(beginSetup).not.toHaveBeenCalled();
  });

  it("upserts the selected provider without dropping other connections or overrides", async () => {
    const raw = {
      currentProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          headers: { "X-Keep": "yes" },
          models: { pro: { thinking: "low" } },
        },
        {
          name: "moonshot",
          profile: "moonshot",
          baseURL: "https://api.moonshot.cn/anthropic",
          apiKey: "sk-moonshot",
        },
      ],
      model: "pro",
    };
    await writeFile(configPath, JSON.stringify(raw), "utf8");
    const pickHorizontal = vi
      .fn()
      .mockImplementation(({ items }: { items: unknown[] }) => items[0]);
    const screen = {
      beginSetup: vi.fn(),
      pickHorizontal,
      setSetupPrompt: vi.fn(),
      promptInput: vi.fn().mockResolvedValue("sk-new"),
      pushSetupEntry: vi.fn(),
      endSetup: vi.fn(),
    } as unknown as Screen;

    const settings = parseSettings(raw);
    await ensureSettings(settings, screen, configPath);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(saved.providers).toHaveLength(2);
    expect(saved.providers[0]).toMatchObject({
      name: "deepseek",
      profile: "deepseek",
      baseURL: "https://api.deepseek.com",
      transport: "openai",
      apiKey: "sk-new",
      headers: { "X-Keep": "yes" },
      models: { pro: { thinking: "low" } },
    });
    expect(saved.providers[1]).toEqual(raw.providers[1]);
    expect(activeProvider(settings)?.apiKey).toBe("sk-new");
    expect(activeModels(settings).pro?.thinking).toBe("low");
    expect(screen.beginSetup).toHaveBeenCalledOnce();
    expect(screen.endSetup).toHaveBeenCalledOnce();
    const picker = pickHorizontal.mock.calls[0]?.[0] as
      | {
          items: Array<{ kind: string }>;
          badge: (choice: { kind: string }) => string | null;
        }
      | undefined;
    expect(picker?.items.map((choice) => choice.kind)).toEqual(["template", "custom"]);
    expect(picker?.badge(picker.items[0] as { kind: string })).toBeNull();
  });

  it("repairs a missing endpoint without asking for the existing provider key again", async () => {
    const raw = {
      currentProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          profile: "deepseek",
          transport: "openai",
          apiKey: "sk-existing",
        },
      ],
      model: "pro",
    };
    await writeFile(configPath, JSON.stringify(raw), "utf8");
    const screen = {
      beginSetup: vi.fn(),
      pickHorizontal: vi.fn().mockImplementation(({ items }: { items: unknown[] }) => items[0]),
      setSetupPrompt: vi.fn(),
      promptInput: vi.fn(),
      pushSetupEntry: vi.fn(),
      endSetup: vi.fn(),
    } as unknown as Screen;

    const settings = parseSettings(raw);
    await ensureSettings(settings, screen, configPath);

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(saved.providers[0]).toMatchObject({
      name: "deepseek",
      baseURL: "https://api.deepseek.com",
      transport: "openai",
      apiKey: "sk-existing",
    });
    expect(screen.promptInput).not.toHaveBeenCalled();
    expect(activeProvider(settings)?.baseURL).toBe("https://api.deepseek.com");
  });

  it("maps the Custom provider choice to a generic-profile config skeleton", async () => {
    const output: string[] = [];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        output.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:0");
    }) as typeof process.exit);
    const screen = {
      beginSetup: vi.fn(),
      pickHorizontal: vi.fn().mockImplementation(({ items }: { items: unknown[] }) => items.at(-1)),
      unmount: vi.fn().mockResolvedValue(undefined),
      endSetup: vi.fn(),
    } as unknown as Screen;

    try {
      await expect(ensureSettings(parseSettings({}), screen, configPath)).rejects.toThrow(
        "process.exit:0",
      );
      const rendered = output.join("");
      expect(rendered).toContain("generic");
      expect(rendered).toContain("<anthropic|openai>");
      expect(rendered).not.toContain("deepseek|moonshot|generic");
    } finally {
      stdoutWrite.mockRestore();
      processExit.mockRestore();
    }
  });
});
