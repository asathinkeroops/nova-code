import { appendFile, readFile } from "node:fs/promises";

/**
 * Kinds that appear in `transcript.jsonl`. Mirrors what the agent actually
 * writes — bootstrap records (`session_start`, `memory_loaded`,
 * `skills_loaded`, `agents_loaded`, `mcp_loaded`, `user_prompt`, `error`) plus
 * the advisory hook points the agent forwards on every turn.
 *
 * `message_injected` carries the nova-authored messages the model reads but no
 * other record covers: the `<compacted>` summary that replaces the history it
 * sees, todo/task reminders, background-command and monitor notifications, the
 * plan-mode reminder, and the interrupt marker. They enter the history through
 * `pre_compact` / `pre_continue` / `pre_request`, none of which fire the hooks
 * the other records mirror — so without this a transcript read on its own
 * cannot explain why the model said what it said.
 *
 * The transcript is append-only and never rolls back, so a `/rewind` that
 * truncates `messages.jsonl` would otherwise leave the two files disagreeing
 * with no way to tell which turns were dropped. `rewind` records the cut so a
 * reader can reconstruct the same final history — while the `post_request`
 * usage of the discarded turns stays counted, since those tokens were spent.
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
  | "agents_loaded"
  | "mcp_loaded"
  | "sandbox_init"
  | "user_prompt"
  | "pre_permission"
  | "post_permission"
  | "post_request"
  | "post_assistant"
  | "post_user_message"
  | "post_stop"
  | "post_compact"
  | "message_injected"
  | "rewind"
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
