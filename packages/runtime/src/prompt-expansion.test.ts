import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHELL_DISABLED_NOTICE,
  expandArgs,
  expandDollarArgs,
  expandMentions,
  expandShell,
  expandVars,
} from "./prompt-expansion.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "nova-expand-"));
}

describe("expandVars", () => {
  it("substitutes known names everywhere they appear", () => {
    expect(expandVars("${A}/x and ${A}/y", { A: "/root" })).toBe("/root/x and /root/y");
  });

  it("leaves unknown names verbatim", () => {
    expect(expandVars("${A} ${B}", { A: "1" })).toBe("1 ${B}");
  });

  it("ignores lowercase and mixed-case references", () => {
    expect(expandVars("${a} ${Ab}", { a: "1", Ab: "2" })).toBe("${a} ${Ab}");
  });

  it("accepts digits and underscores after the first letter", () => {
    expect(expandVars("${A_B2}", { A_B2: "ok" })).toBe("ok");
  });

  it("does not rescan substituted text", () => {
    // A value that itself looks like a reference must not be expanded again.
    expect(expandVars("${A}", { A: "${B}", B: "boom" })).toBe("${B}");
  });
});

describe("expandDollarArgs", () => {
  it("substitutes $ARGUMENTS with the trimmed raw string", () => {
    expect(expandDollarArgs("run $ARGUMENTS now", "  a b  ")).toBe("run a b now");
  });

  it("substitutes positional $1..$N", () => {
    expect(expandDollarArgs("$1/$2/$3", "x y z")).toBe("x/y/z");
  });

  it("blanks a positional beyond what was supplied", () => {
    expect(expandDollarArgs("[$1][$2]", "only")).toBe("[only][]");
  });

  it("handles empty args", () => {
    expect(expandDollarArgs("[$ARGUMENTS][$1]", "")).toBe("[][]");
  });

  it("substitutes $ARGUMENTS[n] 0-indexed", () => {
    expect(expandDollarArgs("$ARGUMENTS[0]/$ARGUMENTS[1]", "x y")).toBe("x/y");
  });

  it("blanks an out-of-range $ARGUMENTS[n] rather than leaking the literal", () => {
    expect(expandDollarArgs("[$ARGUMENTS[5]]", "x")).toBe("[]");
  });

  it("does not let $ARGUMENTS swallow the bracket form", () => {
    // The bracket form must be consumed before the bare $ARGUMENTS pass, or
    // `$ARGUMENTS[0]` would become `x y[0]`.
    expect(expandDollarArgs("$ARGUMENTS[0]", "x y")).toBe("x");
  });

  it("substitutes named arguments", () => {
    expect(expandDollarArgs("go to $path now", "", { named: { path: "/tmp" } })).toBe(
      "go to /tmp now",
    );
  });

  it("prefers the longer name so a short one cannot shadow it", () => {
    expect(expandDollarArgs("$foobar/$foo", "", { named: { foo: "A", foobar: "B" } })).toBe(
      "B/A",
    );
  });

  it("does not substitute a named arg that is only a prefix of a longer word", () => {
    expect(expandDollarArgs("$pathological", "", { named: { path: "/tmp" } })).toBe(
      "$pathological",
    );
  });

  it("honours \\$ escaping for every substitutable form", () => {
    expect(expandDollarArgs("\\$ARGUMENTS \\$1 \\$path", "a", { named: { path: "p" } })).toBe(
      "$ARGUMENTS $1 $path",
    );
  });

  it("uses \\$ to protect a literal price from positional substitution", () => {
    // Unescaped, `$5` would be consumed as a positional. Escaping yields a
    // literal dollar and drops the backslash.
    expect(expandDollarArgs("costs $5.00", "a")).toBe("costs .00");
    expect(expandDollarArgs("costs \\$5.00", "a")).toBe("costs $5.00");
  });

  it("keeps the backslash when the next token is not substitutable", () => {
    expect(expandDollarArgs("echo \\$HOME", "a")).toBe("echo \\$HOME");
  });

  it("reports whether anything bound", () => {
    expect(expandArgs("no placeholders", "a b").bound).toBe(false);
    expect(expandArgs("got $1", "a b").bound).toBe(true);
    expect(expandArgs("escaped \\$1", "a b").bound).toBe(false);
  });
});

describe("expandMentions", () => {
  it("embeds a readable file", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "a.txt"), "AAA", "utf8");
    const out = await expandMentions("see @a.txt", dir);
    expect(out).toContain("Contents of a.txt:");
    expect(out).toContain("AAA");
  });

  it("leaves emails and scoped package names alone", async () => {
    const dir = fixture();
    expect(await expandMentions("x@y.com @scope/pkg", dir)).toBe("x@y.com @scope/pkg");
  });

  it("leaves a directory mention verbatim", async () => {
    const dir = fixture();
    expect(await expandMentions("@.", dir)).toBe("@.");
  });

  it("truncates an oversized file", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "big.txt"), "y".repeat(200_000), "utf8");
    const out = await expandMentions("@big.txt", dir);
    expect(out).toContain("… (truncated)");
    expect(out.length).toBeLessThan(120_000);
  });
});

describe("expandShell", () => {
  const runner = async (command: string) => ({ output: `[ran ${command}]\n`, isError: false });

  it("inlines trimmed command output", async () => {
    expect(await expandShell("a !`ls` b", { runCommand: runner })).toBe("a [ran ls] b");
  });

  it("leaves segments verbatim when no runner is wired", async () => {
    expect(await expandShell("a !`ls` b", {})).toBe("a !`ls` b");
  });

  it("replaces segments with a notice when disabled, without running them", async () => {
    let called = false;
    const spy = async (c: string) => {
      called = true;
      return { output: c, isError: false };
    };
    expect(await expandShell("a !`ls` b", { runCommand: spy, disabled: true })).toBe(
      `a ${SHELL_DISABLED_NOTICE} b`,
    );
    expect(called).toBe(false);
  });

  it("handles multiple segments in one body", async () => {
    expect(await expandShell("!`one` / !`two`", { runCommand: runner })).toBe(
      "[ran one] / [ran two]",
    );
  });
});
