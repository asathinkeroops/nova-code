import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or cwd-relative file path."),
  old_string: z.string().min(1).describe("Exact text to replace. Must match the file content verbatim."),
  new_string: z.string().describe("Replacement text. Must differ from old_string."),
  replace_all: z
    .boolean()
    .default(false)
    .describe("Replace every occurrence when true. When false (default), old_string must occur exactly once."),
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export const editTool: ToolHandler = {
  definition: {
    name: "edit",
    description:
      "Edit a file by replacing exact text. By default old_string must occur exactly once; set replace_all to change every occurrence.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    if (input.old_string === input.new_string) {
      return { output: "edit failed: new_string is identical to old_string", isError: true };
    }
    const abs = resolve(ctx.cwd, input.path);
    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `edit failed: ${msg}`, isError: true };
    }

    const occurrences = countOccurrences(original, input.old_string);
    if (occurrences === 0) {
      return { output: `edit failed: old_string not found in ${abs}`, isError: true };
    }
    if (!input.replace_all && occurrences > 1) {
      return {
        output: `edit failed: old_string occurs ${occurrences} times in ${abs}; provide more context to make it unique or set replace_all=true`,
        isError: true,
      };
    }

    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string);

    try {
      await writeFile(abs, updated, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `edit failed: ${msg}`, isError: true };
    }

    const replaced = input.replace_all ? occurrences : 1;
    return { output: `edited ${abs} (${replaced} replacement${replaced === 1 ? "" : "s"})` };
  },
};
