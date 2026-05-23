import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or cwd-relative file path."),
  offset: z.number().int().min(0).optional().describe("Line offset (0-based)."),
  limit: z.number().int().positive().optional().describe("Max number of lines to return."),
});

const MAX_BYTES = 200_000;

export const readTool: ToolHandler = {
  definition: {
    name: "read",
    description:
      "Read a text file from disk. Returns up to ~200KB; use offset+limit to paginate large files.",
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

    if (input.offset === undefined && input.limit === undefined) {
      if (raw.length <= MAX_BYTES) return { output: raw };
      return {
        output: `${raw.slice(0, MAX_BYTES)}\n…(truncated ${raw.length - MAX_BYTES} bytes; pass offset/limit to paginate)`,
      };
    }

    const lines = raw.split("\n");
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { output: lines.slice(start, end).join("\n") };
  },
};
