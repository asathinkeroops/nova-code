import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PermissionDeniedError,
  PermissionEngine,
  isSensitiveReadPath,
  isWithin,
  sessionGrantDir,
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

  it("matches a `within` path-containment matcher against canonical absolute paths", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [
        { tool: "read", effect: "allow", match: { path: { within: ["/ws/proj", "/extra"] } } },
      ],
    });
    // Inside a root (the root itself, and nested under it) → allow.
    expect(eng.evaluate({ tool: "read", input: { path: "/ws/proj" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "read", input: { path: "/ws/proj/src/a.ts" } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "read", input: { path: "/extra/x" } }).effect).toBe("allow");
    // Sibling dir that merely shares a string prefix → not within → ask.
    expect(eng.evaluate({ tool: "read", input: { path: "/ws/proj-other/x" } }).effect).toBe("ask");
    // Outside every root → ask.
    expect(eng.evaluate({ tool: "read", input: { path: "/etc/passwd" } }).effect).toBe("ask");
    // Relative / non-absolute actual never matches a `within` rule.
    expect(eng.evaluate({ tool: "read", input: { path: "src/a.ts" } }).effect).toBe("ask");
  });

  it("falls back to ask when input access throws during match evaluation", () => {
    const eng = new PermissionEngine({
      defaultEffect: "deny",
      rules: [{ tool: "read", effect: "allow", match: { path: "anything" } }],
    });
    const hostileInput = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error("getter exploded");
      },
    });
    const d = eng.evaluate({ tool: "read", input: hostileInput });
    expect(d.effect).toBe("ask");
    expect(d.reason).toMatch(/getter exploded/);
  });

  it("falls back to ask when stableInputKey throws on an exotic input", async () => {
    const ask: AskCallback = vi.fn(async () => "always-allow");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });
    // Build a runtime bucket so stableInputKey runs on subsequent evaluates.
    await eng.check({ tool: "x", input: { p: "ok" } });
    // BigInt can't be JSON.stringified — without the catch this would throw
    // out of evaluate. With the catch we expect a reasoned ask.
    const d = eng.evaluate({ tool: "x", input: { p: 1n } });
    expect(d.effect).toBe("ask");
    expect(d.reason).toMatch(/permission evaluation error/);
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

describe("isWithin", () => {
  it("treats a path as within itself", () => {
    expect(isWithin("/ws/proj", "/ws/proj")).toBe(true);
  });

  it("treats a nested descendant as within", () => {
    expect(isWithin("/ws/proj", "/ws/proj/src/a.ts")).toBe(true);
  });

  it("rejects a sibling that merely shares a string prefix", () => {
    expect(isWithin("/ws/proj", "/ws/proj-other")).toBe(false);
  });

  it("rejects an ancestor of the parent", () => {
    expect(isWithin("/ws/proj", "/ws")).toBe(false);
  });

  it("rejects when either side is not absolute", () => {
    expect(isWithin("ws/proj", "/ws/proj/a")).toBe(false);
    expect(isWithin("/ws/proj", "proj/a")).toBe(false);
  });
});

describe("PermissionEngine rule evaluation details", () => {
  it("honors first-match-wins ordering (deny before a later allow)", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [
        { tool: "read", effect: "deny" },
        { tool: "read", effect: "allow" },
      ],
    });
    expect(eng.evaluate({ tool: "read", input: { path: "/x" } }).effect).toBe("deny");
  });

  it("requires every key in a multi-key match to match", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "t", effect: "allow", match: { a: "1", b: "2" } }],
    });
    expect(eng.evaluate({ tool: "t", input: { a: "1", b: "2" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "t", input: { a: "1", b: "3" } }).effect).toBe("ask");
  });

  it("matches a nested-object rule when the expected entries are a subset of actual", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "t", effect: "allow", match: { opts: { deep: "v" } } }],
    });
    expect(eng.evaluate({ tool: "t", input: { opts: { deep: "v", extra: 1 } } }).effect).toBe(
      "allow",
    );
    expect(eng.evaluate({ tool: "t", input: { opts: { deep: "x" } } }).effect).toBe("ask");
  });

  it("only screens for dangerous commands on the bash tool", () => {
    const eng = new PermissionEngine({
      defaultEffect: "allow",
      rules: [],
    });
    // A non-bash tool carrying a scary-looking "command" is never auto-denied.
    expect(eng.evaluate({ tool: "shell", input: { command: "rm -rf /" } }).effect).toBe("allow");
  });

  it("does not crash on a bash call whose command is absent or non-string", () => {
    const eng = new PermissionEngine({ defaultEffect: "allow", rules: [] });
    expect(eng.evaluate({ tool: "bash", input: {} }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "bash", input: { command: 123 } }).effect).toBe("allow");
  });
});

describe("PermissionEngine.deniedByRule", () => {
  it("returns a deny decision for the first matching deny rule", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "write", effect: "deny" }],
    });
    const d = eng.deniedByRule({ tool: "write", input: { path: "/x" } });
    expect(d?.effect).toBe("deny");
    expect(d?.reason).toMatch(/deny/);
  });

  it("returns undefined when no rule matches", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "read", effect: "deny" }],
    });
    expect(eng.deniedByRule({ tool: "write", input: { path: "/x" } })).toBeUndefined();
  });

  it("honors first-match-wins: an earlier allow rule wins over a later deny", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [
        { tool: "write", effect: "allow" },
        { tool: "write", effect: "deny" },
      ],
    });
    expect(eng.deniedByRule({ tool: "write", input: { path: "/x" } })).toBeUndefined();
  });

  it("denies when the deny rule precedes a later allow", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [
        { tool: "write", effect: "deny" },
        { tool: "write", effect: "allow" },
      ],
    });
    expect(eng.deniedByRule({ tool: "write", input: { path: "/x" } })?.effect).toBe("deny");
  });

  it("matches on input, so only the selected invocations are denied", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "bash", effect: "deny", match: { command: "/git\\s+push/" } }],
    });
    expect(
      eng.deniedByRule({ tool: "bash", input: { command: "git push origin x" } })?.effect,
    ).toBe("deny");
    expect(eng.deniedByRule({ tool: "bash", input: { command: "git status" } })).toBeUndefined();
  });

  it("does not apply the built-in dangerous-bash check or defaultEffect", () => {
    const eng = new PermissionEngine({ defaultEffect: "deny", rules: [] });
    // `evaluate` would deny this twice over; `deniedByRule` only reports rules.
    expect(eng.deniedByRule({ tool: "bash", input: { command: "rm -rf /" } })).toBeUndefined();
    expect(eng.deniedByRule({ tool: "bash", input: { command: "ls" } })).toBeUndefined();
  });

  it("degrades to no denial when match evaluation throws", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "read", effect: "deny", match: { path: "anything" } }],
    });
    const hostile = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(eng.deniedByRule({ tool: "read", input: hostile })).toBeUndefined();
  });
});

describe("PermissionEngine session allow", () => {
  it("is false until the tool is granted for the session", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    expect(eng.isSessionAllowed({ tool: "bash", input: { command: "ls" } })).toBe(false);
    eng.allowToolForSession("bash");
    expect(eng.isSessionAllowed({ tool: "bash", input: { command: "anything" } })).toBe(true);
  });

  it("scopes the grant to the tool", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    eng.allowToolForSession("bash");
    expect(eng.isSessionAllowed({ tool: "write", input: { path: "/x" } })).toBe(false);
  });

  it("records always-allow answered through check()", async () => {
    const ask: AskCallback = vi.fn(async () => "always-allow");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });
    await eng.check({ tool: "write", input: { path: "/a" } });
    expect(eng.isSessionAllowed({ tool: "write", input: { path: "/b" } })).toBe(true);
  });

  it("is not consulted by evaluate() as a rule (rules still run first)", () => {
    const eng = new PermissionEngine({
      defaultEffect: "ask",
      rules: [{ tool: "bash", effect: "deny" }],
    });
    eng.allowToolForSession("bash");
    // evaluate() checks the runtime bucket before rules, so the session grant
    // wins there; `deniedByRule` is what hosts use to keep a deny absolute.
    expect(eng.evaluate({ tool: "bash", input: { command: "ls" } }).effect).toBe("allow");
    expect(eng.deniedByRule({ tool: "bash", input: { command: "ls" } })?.effect).toBe("deny");
  });
});

describe("sessionGrantDir", () => {
  it("scopes a read to the file's parent directory", () => {
    expect(sessionGrantDir("read", { path: "/ws/proj/src/a.ts" })).toBe("/ws/proj/src");
  });

  it("scopes glob/grep to the search root itself (which may be a file)", () => {
    expect(sessionGrantDir("glob", { path: "/ws/proj/src" })).toBe("/ws/proj/src");
    expect(sessionGrantDir("grep", { path: "/ws/proj/src" })).toBe("/ws/proj/src");
  });

  it("refuses non-read tools, missing/relative paths, and the filesystem root", () => {
    expect(sessionGrantDir("write", { path: "/ws/a.ts" })).toBeUndefined();
    expect(sessionGrantDir("bash", { command: "ls" })).toBeUndefined();
    expect(sessionGrantDir("read", { path: "src/a.ts" })).toBeUndefined();
    expect(sessionGrantDir("read", { path: "/" })).toBeUndefined();
    expect(sessionGrantDir("glob", { path: "/" })).toBeUndefined();
  });

  it("refuses sensitive targets and their containing directory", () => {
    const sshKey = join(homedir(), ".ssh", "id_rsa");
    expect(sessionGrantDir("read", { path: sshKey })).toBeUndefined();
    const envInProject = "/projects/app/.env";
    expect(sessionGrantDir("read", { path: envInProject })).toBeUndefined();
  });
});

describe("isSensitiveReadPath", () => {
  it("flags credential stores, keys, and private history", () => {
    expect(isSensitiveReadPath(join(homedir(), ".ssh", "id_rsa"))).toBe(true);
    expect(isSensitiveReadPath(join(homedir(), ".ssh", "id_rsa.pub"))).toBe(true);
    expect(isSensitiveReadPath(join(homedir(), ".aws", "credentials"))).toBe(true);
    expect(isSensitiveReadPath(join(homedir(), ".nova", "sessions", "s1", "messages.jsonl"))).toBe(
      true,
    );
    expect(isSensitiveReadPath("/etc/shadow")).toBe(true);
    expect(isSensitiveReadPath("/private/etc/shadow")).toBe(true);
    expect(isSensitiveReadPath("/projects/app/.env")).toBe(true);
    expect(isSensitiveReadPath("/projects/app/.env.local")).toBe(true);
    expect(isSensitiveReadPath("/projects/app/server.pem")).toBe(true);
    expect(isSensitiveReadPath("/projects/app/id_ed25519")).toBe(true);
  });

  it("leaves ordinary source/toolchain paths alone", () => {
    expect(isSensitiveReadPath("/usr/lib/node_modules/typescript/lib/tsc.js")).toBe(false);
    expect(isSensitiveReadPath("/projects/app/src/index.ts")).toBe(false);
    expect(isSensitiveReadPath(join(homedir(), ".nvm", "versions", "v20", "bin", "node"))).toBe(
      false,
    );
    expect(isSensitiveReadPath("relative/.env")).toBe(false);
  });
});

describe("PermissionEngine directory grants", () => {
  it("records always-allow-dir through check() and covers later reads in that dir", async () => {
    const ask: AskCallback = vi.fn(async () => "always-allow-dir");
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [], ask });

    const first = await eng.check({ tool: "read", input: { path: "/ws/lib/a.ts" } });
    expect(first.effect).toBe("allow");
    expect(ask).toHaveBeenCalledOnce();

    // Sibling file in the same directory: remembered.
    expect(eng.evaluate({ tool: "read", input: { path: "/ws/lib/b.ts" } }).effect).toBe("allow");
    // A different directory is not covered.
    expect(eng.evaluate({ tool: "read", input: { path: "/ws/other/c.ts" } }).effect).toBe("ask");
    // A read grant covers the whole read family…
    expect(eng.evaluate({ tool: "grep", input: { path: "/ws/lib/b.ts" } }).effect).toBe("allow");
    expect(eng.evaluate({ tool: "glob", input: { path: "/ws/lib" } }).effect).toBe("allow");
    // …but not write tools.
    expect(eng.evaluate({ tool: "write", input: { path: "/ws/lib/b.ts" } }).effect).toBe("ask");
  });

  it("never lets a directory grant cover a sensitive path", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    eng.allowDirectoryForSession("read", homedir());
    expect(
      eng.evaluate({ tool: "read", input: { path: join(homedir(), ".ssh", "id_rsa") } }).effect,
    ).toBe("ask");
    expect(
      eng.evaluate({ tool: "read", input: { path: join(homedir(), "projects", "notes.md") } })
        .effect,
    ).toBe("allow");
  });

  it("collapses nested grants so a parent subsumes its children", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    eng.allowDirectoryForSession("read", "/ws/lib");
    eng.allowDirectoryForSession("read", "/ws/lib/deep");
    eng.allowDirectoryForSession("read", "/ws/lib/deep/deeper");
    eng.allowDirectoryForSession("read", "/ws");
    expect(eng.isSessionAllowed({ tool: "read", input: { path: "/ws/lib/deep/x.ts" } })).toBe(true);
  });

  it("ignores non-absolute grants", () => {
    const eng = new PermissionEngine({ defaultEffect: "ask", rules: [] });
    eng.allowDirectoryForSession("read", "lib");
    expect(eng.isSessionAllowed({ tool: "read", input: { path: "/ws/lib/a.ts" } })).toBe(false);
  });
});
