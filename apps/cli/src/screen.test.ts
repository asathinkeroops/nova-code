import { describe, expect, it, vi } from "vitest";
import { Screen } from "./screen.js";
import type { Card } from "./ui/store.js";

// These exercise the headless-free parts of Screen: it never calls mount(), so
// no Ink/terminal is touched — only the underlying zustand store is mutated.
describe("Screen permission state", () => {
  it("starts in default mode with the bypass off", () => {
    const screen = new Screen();
    expect(screen.getPermissionMode()).toBe("default");
  });

  it("setPermissionMode seeds the initial mode (e.g. --permission-mode)", () => {
    const screen = new Screen();
    screen.setPermissionMode("plan");
    expect(screen.getPermissionMode()).toBe("plan");
  });

  it("reports itself as interactive (a Deny here is a real human rejection)", () => {
    expect(new Screen().interactive).toBe(true);
  });

  it("promptApproval auto-approves once the bypass is armed", async () => {
    const screen = new Screen();
    screen.enableBypass();
    expect(screen.getPermissionMode()).toBe("bypassPermissions");
    // With the bypass on, promptApproval resolves immediately without opening a
    // modal (which would otherwise block forever with no terminal attached).
    await expect(
      screen.promptApproval(
        { effect: "ask", reason: "test" },
        { tool: "write", input: { path: "/tmp/x" } },
      ),
    ).resolves.toBe("always-allow");
  });
});

describe("Screen card persistence sink", () => {
  it("forwards pushed cards to the sink and skips persist:false ones", () => {
    const screen = new Screen();
    const append = vi.fn<[Card], void>();
    const clear = vi.fn();
    screen.setCardSink({ append, clear });

    screen.card("persisted", { title: "/help" });
    screen.card("ephemeral", { persist: false });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({ text: "persisted", title: "/help" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("notifies the sink to clear on clearCards", () => {
    const screen = new Screen();
    const clear = vi.fn();
    screen.setCardSink({ append: vi.fn(), clear });

    screen.card("a");
    screen.clearCards();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("setCards keeps the id counter ahead of restored cards", () => {
    const screen = new Screen();
    const append = vi.fn<[Card], void>();
    screen.setCardSink({ append, clear: vi.fn() });

    screen.setCards([{ id: 42, anchor: -1, kind: "info", text: "restored" }]);
    screen.card("next");

    expect(append.mock.calls[0]?.[0]?.id).toBe(43);
  });
});
