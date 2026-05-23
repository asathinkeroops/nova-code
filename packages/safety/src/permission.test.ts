import { describe, expect, it, vi } from "vitest";
import {
  PermissionDeniedError,
  PermissionEngine,
  type AskCallback,
} from "./permission.js";

describe("PermissionEngine.evaluate", () => {
  it("falls back to defaultEffect when no rule matches", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    expect(eng.evaluate({ tool: "bash", input: { command: "ls" } }).effect).toBe("ask");
  });

  it("matches rule by tool name", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "read", effect: "allow" }],
    });
    expect(eng.evaluate({ tool: "read", input: { path: "/x" } }).effect).toBe("allow");
  });

  it("matches rule by input regex", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "bash", effect: "allow", match: { command: "/^ls\\b/" } }],
    });
    expect(eng.evaluate({ tool: "bash", input: { command: "ls -la" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "bash", input: { command: "cat foo" } }).effect).toBe("ask");
  });

  it("denies bash commands that look catastrophic, regardless of rules", () => {
    const eng = new PermissionEngine({
      defaultEffect: "allow",
      rules: [{ tool: "bash", effect: "allow" }],
    });
    const d = eng.evaluate({ tool: "bash", input: { command: "rm -rf /" } });
    expect(d.effect).toBe("deny");
  });

  it("supports wildcard tool rule", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "*", effect: "allow" }],
    });
    expect(eng.evaluate({ tool: "write", input: { path: "/x" } }).effect).toBe("allow");
  });
});

describe("PermissionEngine.check", () => {
  it("throws PermissionDeniedError when effect is deny", async () => {
    const eng = new PermissionEngine({
      defaultEffect: "deny",
      rules: [],
    });
    await expect(eng.check({ tool: "bash", input: { command: "ls" } })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("calls ask callback on effect=ask and threads the answer", async () => {
    const ask: AskCallback = vi.fn(async () => "yes");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });
    const d = await eng.check({ tool: "bash", input: { command: "ls" } });
    expect(d.effect).toBe("allow");
    expect(ask).toHaveBeenCalledOnce();
  });

  it("denies when ask callback returns no", async () => {
    const ask: AskCallback = vi.fn(async () => "no");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });
    await expect(eng.check({ tool: "bash", input: { command: "ls" } })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("remembers always-allow for subsequent calls on the same tool", async () => {
    const ask: AskCallback = vi.fn(async () => "always-allow");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });
    await eng.check({ tool: "write", input: { path: "/a" } });
    await eng.check({ tool: "write", input: { path: "/b" } });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("throws when effect=ask but no ask callback is configured", async () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    await expect(eng.check({ tool: "bash", input: { command: "ls" } })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});
