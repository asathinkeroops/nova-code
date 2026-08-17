/**
 * File-access invariants: the second half of this package's job. The
 * permission engine decides whether a tool call is *allowed*; this decides
 * whether a write would *clobber* something the agent never looked at.
 *
 * It keys the ledger with the same `canonicalizePath` the permission gate
 * uses, so both agree on what "the real file" is when a call arrives through a
 * symlink or a path alias. The dispatcher-facing contract (`InvariantsCheck`)
 * lives in `@nova/core` next to `FileAccessLedger`, which is what keeps
 * `@nova/tools` free of a dependency on this package.
 */
import { stat } from "node:fs/promises";
import type { FileAccessLedger, InvariantsCheck, ToolContext, ToolUseBlock } from "@nova/core";
import { canonicalizePath } from "@nova/base";

/**
 * In-memory file access ledger. One instance per session — the CLI constructs
 * it and threads it through ToolContext so the invariants layer can record
 * reads (with mtime) and consult them on subsequent edits/writes.
 *
 * Keys are absolute, symlink-resolved paths (canonicalizePath from
 * @nova/base — the same canonicalization the permission gate uses). This
 * makes read and edit/write agree on a single key even when one call reaches a
 * file through a symlink or path alias and another through its real path, so
 * read-before-edit and mtime-drift compare like for like.
 */
export class InMemoryFileAccessLedger implements FileAccessLedger {
  private readonly entries = new Map<string, { lastReadMtimeMs: number }>();

  recordRead(absPath: string, mtimeMs: number): void {
    this.entries.set(absPath, { lastReadMtimeMs: mtimeMs });
  }

  recordWrite(absPath: string, mtimeMs: number): void {
    // After a successful write the on-disk content is exactly what the agent
    // intended, so subsequent edits don't need a fresh read. Treat the write
    // as if it was also a read for the purposes of read-before-edit and mtime.
    this.entries.set(absPath, { lastReadMtimeMs: mtimeMs });
  }

  get(absPath: string): { lastReadMtimeMs: number } | undefined {
    return this.entries.get(absPath);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface InvariantsOptions {
  readBeforeEdit: boolean;
  mtimeCheck: boolean;
}

interface PathAccess {
  abs: string;
  kind: "read" | "write" | "edit";
}

/**
 * Map a `tool_use` to the file path it's about to touch, canonicalized to its
 * real (symlink-resolved) absolute path so the ledger key matches the bytes the
 * tool reads/writes. Returns null for tools we don't gate (everything except
 * read/write/edit).
 */
async function extractAccess(use: ToolUseBlock, ctx: ToolContext): Promise<PathAccess | null> {
  let kind: PathAccess["kind"];
  switch (use.name) {
    case "read":
    case "write":
    case "edit":
      kind = use.name;
      break;
    default:
      return null;
  }
  const input = use.input as Record<string, unknown>;
  const rawPath = typeof input.path === "string" ? input.path : null;
  if (!rawPath) return null;
  return { abs: await canonicalizePath(ctx.cwd, rawPath), kind };
}

async function statMtimeMs(abs: string): Promise<number | null> {
  try {
    const s = await stat(abs);
    return s.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function createInvariants(opts: InvariantsOptions): InvariantsCheck {
  return {
    async preCheck(use, ctx) {
      const access = await extractAccess(use, ctx);
      if (!access) return { ok: true };

      const ledger = ctx.fileLedger;
      const onDiskMtime = await statMtimeMs(access.abs);

      if (access.kind === "edit") {
        if (onDiskMtime === null) {
          return { ok: false, message: `edit refused: ${access.abs} does not exist` };
        }
        if (opts.readBeforeEdit && ledger && !ledger.get(access.abs)) {
          return {
            ok: false,
            message: `edit refused: ${access.abs} must be read first (use the read tool, then retry)`,
          };
        }
        if (opts.mtimeCheck && ledger) {
          const record = ledger.get(access.abs);
          if (record && record.lastReadMtimeMs !== onDiskMtime) {
            return {
              ok: false,
              message: `edit refused: ${access.abs} changed on disk since the last read (mtime drift); re-read before editing`,
            };
          }
        }
      } else if (access.kind === "write") {
        // Brand-new file → creating it is fine without a prior read.
        if (onDiskMtime !== null) {
          if (opts.readBeforeEdit && ledger && !ledger.get(access.abs)) {
            return {
              ok: false,
              message: `write refused: ${access.abs} already exists and must be read first before overwriting`,
            };
          }
          if (opts.mtimeCheck && ledger) {
            const record = ledger.get(access.abs);
            if (record && record.lastReadMtimeMs !== onDiskMtime) {
              return {
                ok: false,
                message: `write refused: ${access.abs} changed on disk since the last read (mtime drift); re-read before overwriting`,
              };
            }
          }
        }
      }

      return { ok: true };
    },

    async postCommit(use, ctx, isError) {
      if (isError) return;
      const access = await extractAccess(use, ctx);
      if (!access) return;
      const ledger = ctx.fileLedger;
      if (!ledger) return;

      // For read/write, refresh the ledger with the current on-disk mtime so
      // subsequent edits see a matching baseline. For edits we also refresh,
      // because edit mutates the file and the old mtime is now stale.
      const mtime = await statMtimeMs(access.abs);
      if (mtime === null) return;
      if (access.kind === "read") {
        ledger.recordRead(access.abs, mtime);
      } else {
        ledger.recordWrite(access.abs, mtime);
      }
    },
  };
}
