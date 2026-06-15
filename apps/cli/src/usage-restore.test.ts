import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreUsageFromTranscript } from "./usage-restore.js";

async function writeTranscript(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("restoreUsageFromTranscript", () => {
  it("sums usage across every post_request record", async () => {
    const path = await writeTranscript([
      { kind: "session_start", data: { id: "s1" } },
      {
        kind: "post_request",
        data: {
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 50,
          },
        },
      },
      // A second run of the same session appended more requests.
      { kind: "session_start", data: { id: "s1", resumed: true } },
      {
        kind: "post_request",
        data: {
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 5,
          },
        },
      },
    ]);
    expect(await restoreUsageFromTranscript(path)).toEqual({
      cacheReadTokens: 1000,
      cacheCreationTokens: 55,
      uncachedInputTokens: 120,
      outputTokens: 40,
    });
  });

  it("ignores non-request records and post_requests without usage (errors/aborts)", async () => {
    const path = await writeTranscript([
      { kind: "user_prompt", data: { text: "hi" } },
      { kind: "post_request", data: { error: "aborted", durationMs: 5 } },
      { kind: "post_request", data: { usage: { inputTokens: 10, outputTokens: 4 } } },
    ]);
    expect(await restoreUsageFromTranscript(path)).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 10,
      outputTokens: 4,
    });
  });

  it("returns all-zero when the transcript is absent (fresh / noTranscript session)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
    expect(await restoreUsageFromTranscript(join(dir, "transcript.jsonl"))).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});
