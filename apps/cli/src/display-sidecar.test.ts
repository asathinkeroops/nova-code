import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendToolDetail,
  appendUserOverride,
  clearDisplaySidecar,
  displayOverridesPath,
  loadDisplaySidecar,
} from "./display-sidecar.js";

describe("display sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nova-display-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty maps when the file is absent", async () => {
    expect(await loadDisplaySidecar(dir)).toEqual({ userOverrides: {}, toolDetails: {} });
  });

  it("round-trips user overrides into a map", async () => {
    await appendUserOverride(dir, "EXPANDED a", "/agent a task");
    await appendUserOverride(dir, "EXPANDED b", "/plan b");
    const { userOverrides } = await loadDisplaySidecar(dir);
    expect(userOverrides).toEqual({
      "EXPANDED a": "/agent a task",
      "EXPANDED b": "/plan b",
    });
  });

  it("round-trips sub-agent details keyed by tool_use id", async () => {
    await appendToolDetail(dir, "use_1", [
      { type: "thinking", text: "planning" },
      { type: "tool_use", name: "grep", summary: "foo" },
      { type: "final", text: "done" },
    ]);
    const { toolDetails } = await loadDisplaySidecar(dir);
    expect(toolDetails).toEqual({
      use_1: [
        { type: "thinking", text: "planning" },
        { type: "tool_use", name: "grep", summary: "foo" },
        { type: "final", text: "done" },
      ],
    });
  });

  it("lets a later record win on key collision (append-only dedup)", async () => {
    await appendUserOverride(dir, "K", "first");
    await appendUserOverride(dir, "K", "second");
    await appendToolDetail(dir, "use_1", [{ type: "thinking", text: "a" }]);
    await appendToolDetail(dir, "use_1", [{ type: "final", text: "b" }]);
    const { userOverrides, toolDetails } = await loadDisplaySidecar(dir);
    expect(userOverrides).toEqual({ K: "second" });
    expect(toolDetails).toEqual({ use_1: [{ type: "final", text: "b" }] });
  });

  it("skips malformed lines and bad detail entries rather than throwing", async () => {
    await appendUserOverride(dir, "good", "/x");
    await writeFile(
      displayOverridesPath(dir),
      `not json\n{"kind":"user-override","expanded":123}\n{"kind":"user-override","expanded":"ok","raw":"/y"}\n` +
        `{"kind":"tool-detail","toolUseId":"u","entries":[{"type":"bogus"},{"type":"final","text":"ok"}]}\n`,
      { flag: "a" },
    );
    const { userOverrides, toolDetails } = await loadDisplaySidecar(dir);
    expect(userOverrides).toEqual({ good: "/x", ok: "/y" });
    expect(toolDetails).toEqual({ u: [{ type: "final", text: "ok" }] });
  });

  it("clear removes the sidecar and is a no-op when already gone", async () => {
    await appendUserOverride(dir, "K", "v");
    await clearDisplaySidecar(dir);
    expect(await loadDisplaySidecar(dir)).toEqual({ userOverrides: {}, toolDetails: {} });
    await expect(clearDisplaySidecar(dir)).resolves.toBeUndefined();
  });
});
