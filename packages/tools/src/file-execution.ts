import { canonicalizePath } from "@nova/base";
import type { ToolContext } from "@nova/core";

/**
 * Resolve normalized file-tool input to the resource key used by the
 * dispatcher's keyed executor. The schema has already rewritten path aliases
 * before this runs, so only the canonical `path` field is accepted here.
 */
export async function fileExecutionKey(
  input: unknown,
  ctx: ToolContext,
): Promise<string | undefined> {
  if (!input || typeof input !== "object") return undefined;
  const rawPath = (input as { path?: unknown }).path;
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
  return `file:${await canonicalizePath(ctx.cwd, rawPath)}`;
}
