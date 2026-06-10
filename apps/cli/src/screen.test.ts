import { describe, expect, it } from "vitest";
import { Screen } from "./screen.js";

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

  it("promptApproval auto-approves once the bypass is armed", async () => {
    const screen = new Screen();
    screen.setSkipPermissions(true);
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
