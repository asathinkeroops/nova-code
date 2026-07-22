import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en.js";
import { deepMerge } from "./merge.js";
import { getLocale, resolveUiLocale, setLocale, t } from "./index.js";

// Tests mutate the module-global locale; restore the default afterward so other
// suites (which assert English output) are unaffected.
afterEach(() => setLocale("en"));

describe("resolveUiLocale", () => {
  it("maps every zh* tag to Chinese", () => {
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hans", "ZH", "zh_CN"]) {
      expect(resolveUiLocale(tag)).toBe("zh");
    }
  });

  it("maps everything else — including undefined — to English", () => {
    for (const tag of ["en", "en-US", "fr", "ja", "", undefined]) {
      expect(resolveUiLocale(tag)).toBe("en");
    }
  });
});

describe("setLocale / t", () => {
  it("defaults to English and reports the active locale", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t.commands.help).toBe("show this help");
  });

  it("switches the active catalog to Chinese", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh");
    expect(t.commands.help).toBe("显示帮助");
  });

  it("follows `language` when the `locale` override is 'auto' (or omitted)", () => {
    setLocale("zh-CN", "auto");
    expect(getLocale()).toBe("zh");
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh");
  });

  it("lets an explicit `locale` override `language` (UI-only escape hatch)", () => {
    setLocale("en", "zh-CN"); // model answers in English, UI in Chinese
    expect(getLocale()).toBe("zh");
    setLocale("zh-CN", "en"); // model answers in Chinese, UI in English
    expect(getLocale()).toBe("en");
  });

  it("falls back to English for a locale that does not translate a key", () => {
    // Build a zh-like partial that omits `commands.help`; the merge must keep
    // the English leaf rather than dropping it.
    const merged = deepMerge(en, { commands: { model: "型号" } });
    expect(merged.commands.model).toBe("型号");
    expect(merged.commands.help).toBe("show this help");
  });

  it("does not mutate the English source when merging", () => {
    deepMerge(en, { commands: { help: "X" } });
    expect(en.commands.help).toBe("show this help");
  });
});
