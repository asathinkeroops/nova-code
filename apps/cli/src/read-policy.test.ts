import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_READ_TOOLS, isAutoAllowedReadPath } from "./read-policy.js";

describe("isAutoAllowedReadPath", () => {
  it("allows toolchain and package-manager trees", () => {
    expect(isAutoAllowedReadPath("/usr/lib/node_modules/typescript/lib/tsc.js")).toBe(true);
    expect(isAutoAllowedReadPath("/opt/homebrew/lib/node_modules/x/index.js")).toBe(true);
    expect(
      isAutoAllowedReadPath(join(homedir(), ".nvm/versions/node/v20/lib/node_modules/x.js")),
    ).toBe(true);
    expect(isAutoAllowedReadPath(join(homedir(), ".cargo/registry/src/x/lib.rs"))).toBe(true);
    expect(isAutoAllowedReadPath(join(homedir(), "go/pkg/mod/github.com/x/y@v1/z.go"))).toBe(true);
  });

  it("allows temp trees in canonical (/private) form too", () => {
    expect(isAutoAllowedReadPath("/tmp/nova/report.txt")).toBe(true);
    expect(isAutoAllowedReadPath("/private/tmp/nova/report.txt")).toBe(true);
    expect(isAutoAllowedReadPath("/var/folders/ab/cd/T/out.json")).toBe(true);
  });

  it("never allows sensitive paths, even under an allowlisted-looking tree", () => {
    expect(isAutoAllowedReadPath(join(homedir(), ".ssh", "id_rsa"))).toBe(false);
    expect(isAutoAllowedReadPath(join(homedir(), ".npmrc"))).toBe(false);
    expect(
      isAutoAllowedReadPath(join(homedir(), ".nova", "sessions", "s1", "messages.jsonl")),
    ).toBe(false);
    expect(isAutoAllowedReadPath(join(homedir(), ".aws", "credentials"))).toBe(false);
  });

  it("leaves ordinary outside projects and documents to the ask flow", () => {
    expect(isAutoAllowedReadPath("/srv/app/src/index.ts")).toBe(false);
    expect(isAutoAllowedReadPath(join(homedir(), "Documents/notes.md"))).toBe(false);
    expect(isAutoAllowedReadPath(join(homedir(), "other-project/src/a.ts"))).toBe(false);
  });

  it("covers exactly the read family", () => {
    expect([...AUTO_READ_TOOLS].sort()).toEqual(["glob", "grep", "read"]);
  });
});
