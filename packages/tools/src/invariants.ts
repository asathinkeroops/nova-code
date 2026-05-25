import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileAccessLedger, ToolContext, ToolUseBlock } from "@nova/core";

/**
 * In-memory file access ledger. One instance per session — the CLI constructs
 * it and threads it through ToolContext so the invariants layer can record
 * reads (with mtime) and consult them on subsequent edits/writes.
 *
 * Keys are absolute, posix-normalized paths. We do NOT realpath() symlinks
 * here: the dispatcher already resolves the absolute path that hits the disk,
 * and storing the same string the tool reads/writes keeps lookup trivial.
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

export interface InvariantViolation {
  ok: false;
  message: string;
}

export interface InvariantsCheck {
  preCheck(use: ToolUseBlock, ctx: ToolContext): Promise<{ ok: true } | InvariantViolation>;
  postCommit(use: ToolUseBlock, ctx: ToolContext, isError: boolean): Promise<void>;
}

interface PathAccess {
  abs: string;
  kind: "read" | "write" | "edit";
}

/**
 * Map a `tool_use` to the file path(s) it's about to touch. Returns null for
 * tools we don't gate (everything except read/write/edit in M2).
 */
function extractAccess(use: ToolUseBlock, ctx: ToolContext): PathAccess | null {
  const input = use.input as Record<string, unknown>;
  const rawPath = typeof input.path === "string" ? input.path : null;
  if (!rawPath) return null;
  const abs = resolve(ctx.cwd, rawPath);
  switch (use.name) {
    case "read":
      return { abs, kind: "read" };
    case "write":
      return { abs, kind: "write" };
    case "edit":
      return { abs, kind: "edit" };
    default:
      return null;
  }
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
      const access = extractAccess(use, ctx);
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
      const access = extractAccess(use, ctx);
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
