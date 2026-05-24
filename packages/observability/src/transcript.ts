import { appendFile, readFile } from "node:fs/promises";

export type TranscriptKind =
  | "session_start"
  | "memory_loaded"
  | "user_prompt"
  | "request_start"
  | "request_end"
  | "assistant"
  | "tool_use"
  | "permission_start"
  | "permission_end"
  | "tool_result"
  | "user"
  | "stop"
  | "interject"
  | "compact_end"
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
