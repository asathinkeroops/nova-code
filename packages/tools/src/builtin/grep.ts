import { isAbsolute, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { execa, type ExecaError } from "execa";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  pattern: z.string().min(1).describe("Regex pattern (ripgrep syntax) to search for."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search (absolute or cwd-relative). Defaults to the session cwd."),
  glob: z
    .string()
    .optional()
    .describe("Optional glob filter on file paths, e.g. '*.ts' or '!**/dist/**'. Passed as ripgrep's -g."),
  case_insensitive: z
    .boolean()
    .default(false)
    .describe("Match case-insensitively (ripgrep -i)."),
  fixed_strings: z
    .boolean()
    .default(false)
    .describe("Treat pattern as a literal string instead of a regex (ripgrep -F)."),
  before_context: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of leading context (ripgrep -B)."),
  after_context: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of trailing context (ripgrep -A)."),
  max_count: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(500)
    .describe("Max number of matching lines to return overall (ripgrep -m)."),
  files_with_matches: z
    .boolean()
    .default(false)
    .describe("Only list file paths that contain matches (ripgrep -l). Cheaper for broad searches."),
});

const MAX_OUTPUT = 200_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n…(truncated ${s.length - MAX_OUTPUT} bytes)`;
}

export const grepTool: ToolHandler = {
  definition: {
    name: "grep",
    description:
      "Search file contents with ripgrep (bundled). Use this to find code, references, or text in files; use glob instead when you only need to list files by name. Respects .gitignore by default.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    const target = input.path
      ? isAbsolute(input.path)
        ? input.path
        : resolve(ctx.cwd, input.path)
      : ctx.cwd;

    const args: string[] = ["--color=never"];
    if (input.files_with_matches) {
      args.push("-l");
    } else {
      args.push("--no-heading", "--with-filename", "--line-number");
      if (input.before_context !== undefined) args.push("-B", String(input.before_context));
      if (input.after_context !== undefined) args.push("-A", String(input.after_context));
      args.push("-m", String(input.max_count));
    }
    if (input.case_insensitive) args.push("-i");
    if (input.fixed_strings) args.push("-F");
    if (input.glob) args.push("-g", input.glob);
    args.push("--", input.pattern, target);

    try {
      const result = await execa(rgPath, args, {
        cwd: ctx.cwd,
        reject: false,
        timeout: 30_000,
        ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
      });

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const code = (result as { code?: string }).code;
      if (code === "ENOENT") {
        return {
          output: `grep failed: bundled ripgrep binary missing at ${rgPath}. Reinstall @nova/tools to repair.`,
          isError: true,
        };
      }
      const exit = result.exitCode;

      // ripgrep exit codes: 0 = matches, 1 = no matches, 2+ = error
      if (exit === 1 && !stderr) {
        return { output: `(no matches for ${input.pattern} under ${target})` };
      }
      if (exit === undefined || exit >= 2) {
        return {
          output: `grep failed (exit=${exit ?? "?"}): ${stderr || stdout || "unknown error"}`,
          isError: true,
        };
      }
      const out = truncate(stdout);
      return { output: out.length === 0 ? "(no output)" : out };
    } catch (err) {
      const e = err as ExecaError;
      if ((e as { code?: string }).code === "ENOENT") {
        return {
          output: `grep failed: bundled ripgrep binary missing at ${rgPath}. Reinstall @nova/tools to repair.`,
          isError: true,
        };
      }
      return {
        output: `grep failed: ${e.shortMessage ?? e.message ?? String(err)}`,
        isError: true,
      };
    }
  },
};
