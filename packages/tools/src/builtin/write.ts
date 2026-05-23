import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or cwd-relative file path."),
  content: z.string().describe("Full file contents. Overwrites any existing file at this path."),
  create_dirs: z
    .boolean()
    .default(true)
    .describe("Create missing parent directories if true (default)."),
});

export const writeTool: ToolHandler = {
  definition: {
    name: "write",
    description:
      "Write text content to a file. Overwrites the entire file if it exists. Creates parent directories by default.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const abs = resolve(ctx.cwd, input.path);
    try {
      if (input.create_dirs) {
        await mkdir(dirname(abs), { recursive: true });
      }
      await writeFile(abs, input.content, "utf8");
      return { output: `wrote ${input.content.length} bytes to ${abs}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `write failed: ${msg}`, isError: true };
    }
  },
};
