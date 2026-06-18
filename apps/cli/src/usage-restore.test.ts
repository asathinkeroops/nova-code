import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

/** Serialize transcript records to a JSONL file at `path`. */
async function writeJsonl(path: string, lines: object[]): Promise<void> {
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function requestRecord(usage: Record<string, number>): object {
  return { kind: "post_request", data: { usage } };
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

  it("folds sub-agent transcripts into the totals when a subagents dir is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
    const main = join(dir, "transcript.jsonl");
    await writeJsonl(main, [
      requestRecord({ inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 800 }),
    ]);
    const subDir = join(dir, "subagents");
    await mkdir(subDir);
    await writeJsonl(join(subDir, "sub-aaaa.transcript.jsonl"), [
      requestRecord({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 40 }),
    ]);
    await writeJsonl(join(subDir, "sub-bbbb.transcript.jsonl"), [
      requestRecord({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3 }),
    ]);
    // A non-transcript file in the dir must be ignored.
    await writeJsonl(join(subDir, "sub-aaaa.messages.jsonl"), [
      requestRecord({ inputTokens: 9999, outputTokens: 9999 }),
    ]);

    expect(await restoreUsageFromTranscript(main, subDir)).toEqual({
      cacheReadTokens: 840,
      cacheCreationTokens: 3,
      uncachedInputTokens: 111,
      outputTokens: 37,
    });
  });

  it("ignores a missing subagents dir (no sub-agent ever ran)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nova-usage-"));
    const main = join(dir, "transcript.jsonl");
    await writeJsonl(main, [requestRecord({ inputTokens: 5, outputTokens: 2 })]);
    expect(await restoreUsageFromTranscript(main, join(dir, "subagents"))).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      uncachedInputTokens: 5,
      outputTokens: 2,
    });
  });
});
