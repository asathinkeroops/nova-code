import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SubAgentDetail } from "@nova/subagent";

/**
 * Per-session "display sidecar": out-of-band, display-only metadata that the
 * renderer overlays on the canonical transcript. It never changes what the
 * model sees (that's `messages.jsonl`) — it only changes what the UI shows, and
 * it survives `/resume` / `-c`. Two kinds today, both keyed to something stable
 * in `messages.jsonl`:
 *
 *  - `user-override`: for slash commands that EXPAND into a longer model prompt
 *    (e.g. `/agent`, `/plan`, `/init`), the user's original typed input. Keyed
 *    by the expanded model text (the exact user-message string content); the
 *    renderer shows the original input instead of the expansion.
 *  - `tool-detail`: the latest few progress details (thinking / tool_use /
 *    final) streamed out of a sub-agent run, keyed by the parent `tool_use` id
 *    so they render under the right tool-call card. The parent message only
 *    persists the sub-agent's final report, so without this the details would
 *    vanish on resume.
 *
 * Stored as JSONL (one record per line, append-only) so recording never
 * rewrites the file; on load, later records win on key collision. Lives next to
 * `messages.jsonl`.
 */

const FILENAME = "display-sidecar.jsonl";

type DisplayRecord =
  | { kind: "user-override"; expanded: string; raw: string }
  | { kind: "tool-detail"; toolUseId: string; entries: SubAgentDetail[] };

/** Folded, render-ready view of the sidecar. */
export interface DisplaySidecar {
  /** expanded-model-text → original user input. */
  userOverrides: Record<string, string>;
  /** parent tool_use id → latest sub-agent progress details. */
  toolDetails: Record<string, SubAgentDetail[]>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Validate one sub-agent detail entry; null on any shape mismatch. */
function asDetail(value: unknown): SubAgentDetail | null {
  if (!isObj(value)) return null;
  if (value.type === "thinking" && typeof value.text === "string") {
    return { type: "thinking", text: value.text };
  }
  if (
    value.type === "tool_use" &&
    typeof value.name === "string" &&
    typeof value.summary === "string"
  ) {
    return { type: "tool_use", name: value.name, summary: value.summary };
  }
  if (value.type === "final" && typeof value.text === "string") {
    return { type: "final", text: value.text };
  }
  return null;
}

/** Coerce one parsed JSONL value into a record; null on any shape mismatch. */
function asRecord(value: unknown): DisplayRecord | null {
  if (!isObj(value)) return null;
  if (value.kind === "tool-detail") {
    if (typeof value.toolUseId !== "string" || !Array.isArray(value.entries)) return null;
    const entries = value.entries.map(asDetail).filter((d): d is SubAgentDetail => d !== null);
    return { kind: "tool-detail", toolUseId: value.toolUseId, entries };
  }
  if (
    value.kind === "user-override" &&
    typeof value.expanded === "string" &&
    typeof value.raw === "string"
  ) {
    return { kind: "user-override", expanded: value.expanded, raw: value.raw };
  }
  return null;
}

export function displayOverridesPath(sessionDir: string): string {
  return join(sessionDir, FILENAME);
}

/**
 * Read the sidecar and fold it into a {@link DisplaySidecar}. Missing file →
 * empty maps. Malformed lines are skipped rather than fatal — a corrupt display
 * hint must never block resuming a session.
 */
export async function loadDisplaySidecar(sessionDir: string): Promise<DisplaySidecar> {
  const result: DisplaySidecar = { userOverrides: {}, toolDetails: {} };
  let raw: string;
  try {
    raw = await readFile(displayOverridesPath(sessionDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;
    if (rec.kind === "user-override") result.userOverrides[rec.expanded] = rec.raw;
    else result.toolDetails[rec.toolUseId] = rec.entries;
  }
  return result;
}

async function append(sessionDir: string, rec: DisplayRecord): Promise<void> {
  await appendFile(displayOverridesPath(sessionDir), JSON.stringify(rec) + "\n", "utf8");
}

/** Append one slash-expansion override (expanded model text → typed input). */
export async function appendUserOverride(
  sessionDir: string,
  expanded: string,
  rawInput: string,
): Promise<void> {
  await append(sessionDir, { kind: "user-override", expanded, raw: rawInput });
}

/** Append one sub-agent's latest progress details, keyed by parent tool_use id. */
export async function appendToolDetail(
  sessionDir: string,
  toolUseId: string,
  entries: SubAgentDetail[],
): Promise<void> {
  await append(sessionDir, { kind: "tool-detail", toolUseId, entries });
}

/** Remove the sidecar entirely (used by `/clear`). ENOENT is a no-op. */
export async function clearDisplaySidecar(sessionDir: string): Promise<void> {
  await rm(displayOverridesPath(sessionDir), { force: true });
}
