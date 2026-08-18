import { describe, expect, it } from "vitest";
import { renderBangRecord } from "./repl.js";

describe("renderBangRecord", () => {
  it("puts a successful capture in <bash-stdout> and leaves <bash-stderr> empty", () => {
    expect(renderBangRecord("echo hello", { output: "hello\n" })).toBe(
      "<bash-input>echo hello</bash-input>\n" +
        "<bash-stdout>hello</bash-stdout>\n" +
        "<bash-stderr></bash-stderr>",
    );
  });

  it("puts a failed capture in <bash-stderr> instead", () => {
    // The bash tool merges stdout+stderr into one stream, so a failed run has
    // exactly one place to go — and the exit line rides along with it.
    const record = renderBangRecord("false", { output: "exit=1 \n", isError: true });
    expect(record).toContain("<bash-stdout></bash-stdout>");
    expect(record).toContain("<bash-stderr>exit=1</bash-stderr>");
  });

  it("emits both tags even when the command printed nothing", () => {
    expect(renderBangRecord("true", { output: "" })).toBe(
      "<bash-input>true</bash-input>\n" +
        "<bash-stdout></bash-stdout>\n" +
        "<bash-stderr></bash-stderr>",
    );
  });
});
