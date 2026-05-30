import { appendFile, readFile } from "node:fs/promises";

/**
 * Kinds that appear in `transcript.jsonl`. Mirrors what the agent actually
 * writes — bootstrap records (`session_start`, `memory_loaded`,
 * `skills_loaded`, `mcp_loaded`, `user_prompt`, `error`) plus the advisory hook points the
 * agent forwards on every turn.
 *
 * Older sessions on disk may contain pre-rename kinds (`request_end`,
 * `assistant`, `tool_use`, …); `Transcript.readAll` casts the parsed JSON
 * as `TranscriptRecord` rather than re-validating, so legacy files still
 * load. Don't add the old names back — newly-written records should only
 * use the set below.
 */
export type TranscriptKind =
  | "session_start"
  | "memory_loaded"
  | "skills_loaded"
  | "mcp_loaded"
  | "user_prompt"
  | "pre_permission"
  | "post_permission"
  | "post_request"
  | "post_assistant"
  | "post_user_message"
  | "post_stop"
  | "post_compact"
  | "error";

export interface TranscriptRecord {
  timestamp: string;
  turn?: number;
  kind: TranscriptKind;
  data: unknown;
}

export class Transcript {
  private queue = Promise.resolve();

  constructor(public readonly path: string) {}

  append(record: Omit<TranscriptRecord, "timestamp">): Promise<void> {
    const full: TranscriptRecord = {
      timestamp: new Date().toISOString(),
      ...record,
    };
    const line = `${JSON.stringify(full)}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.path, line, "utf8"))
      .catch((err) => {
        // last-ditch: don't lose downstream writes if one fails
        process.stderr.write(`transcript write failed: ${String(err)}\n`);
      });
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async readAll(): Promise<TranscriptRecord[]> {
    await this.flush();
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as TranscriptRecord);
    } catch {
      return [];
    }
  }
}
