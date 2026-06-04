import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

// Secondary safety budget on the size of a single response, measured in JS
// string length (UTF-16 code units ≈ characters), NOT disk bytes. The model-
// facing unit for offset/limit is LINES — far more intuitive than a character
// count — but we still cap the total characters returned so one page can't blow
// up the context. The one exception: a single line longer than this budget is
// returned whole (we never cut inside a line), so a minified file comes back
// intact rather than mangled.
const MAX_CHARS = 200_000;

// Width the line number is right-padded to, `cat -n` style. Numbers wider than
// this simply aren't padded (padStart only ever grows a string).
const LINE_NO_WIDTH = 6;

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or cwd-relative file path."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number to start reading from (default 1). To continue a large file, pass the offset shown in the previous call's truncation note.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max number of lines to return. The response is also capped at ~${MAX_CHARS} characters (a single longer line is returned whole).`,
    ),
});

export const readTool: ToolHandler = {
  definition: {
    name: "read",
    description:
      "Read a text file from disk. Output is line-numbered (`<line>\\t<text>`, `cat -n` style, 1-based); returns up to `limit` lines (and at most ~200K characters) per call. If more remains, the result tells you the exact read(path, offset) call to continue from. The line-number prefix is display only — strip it before passing text to `edit`.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const abs = resolve(ctx.cwd, input.path);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `read failed: ${msg}`, isError: true };
    }

    // Split into lines, each KEEPING its own trailing "\n" (the final line has
    // none iff the file doesn't end in a newline). A trailing newline does NOT
    // create a phantom empty final line.
    const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const total = lines.length;

    const startLine = input.offset ?? 1;
    const startIdx = startLine - 1;
    if (startIdx >= total && total > 0) {
      return {
        output: `read: offset ${startLine} is past end of file (it has ${total} lines)`,
        isError: true,
      };
    }

    // Take whole lines from `startIdx`, stopping at the line limit or once
    // another line would push us past the character budget — whichever comes
    // first. We always take at least one line, so a single oversized line is
    // returned whole (breaking the char cap) rather than split mid-line.
    let endIdx = startIdx;
    let chars = 0;
    while (endIdx < total) {
      if (input.limit !== undefined && endIdx - startIdx >= input.limit) break;
      const lineLen = lines[endIdx]!.length;
      if (chars > 0 && chars + lineLen > MAX_CHARS) break;
      chars += lineLen;
      endIdx += 1;
    }

    // Render `cat -n` style: right-padded 1-based line number, a tab, then the
    // line's text with its own newline stripped (display lines are rejoined with
    // "\n"). The prefix is display only — `edit` matches the raw file bytes.
    const body = lines
      .slice(startIdx, endIdx)
      .map((line, k) => {
        const n = String(startIdx + k + 1).padStart(LINE_NO_WIDTH);
        const text = line.endsWith("\n") ? line.slice(0, -1) : line;
        return `${n}\t${text}`;
      })
      .join("\n");

    if (endIdx < total) {
      // More lines remain. Name the FULL next call including the path: a hint
      // that only names the offset tends to make the model "continue" with
      // { offset } alone and drop the (seemingly implicit) path, re-triggering
      // the required-path error.
      return {
        output: `${body}\n…(truncated; showing lines ${startIdx + 1}-${endIdx} of ${total}; continue with read(path="${input.path}", offset=${endIdx + 1}))`,
      };
    }
    return { output: body };
  },
};
