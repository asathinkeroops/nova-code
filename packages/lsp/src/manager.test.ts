import { describe, expect, it } from "vitest";
import { LspManager } from "./manager.js";

describe("LspManager.status", () => {
  it("reports availability per configured server and running=false before use", () => {
    const m = new LspManager({
      root: "/tmp",
      servers: [
        { languageId: "node-ish", command: "node", args: [], extensions: ["x"] },
        { languageId: "bogus", command: "definitely-not-real-xyz123", args: [], extensions: ["y"] },
      ],
    });
    const status = m.status();
    expect(status).toHaveLength(2);

    const nodeish = status.find((s) => s.languageId === "node-ish");
    expect(nodeish).toMatchObject({ command: "node", available: true, running: false });
    expect(nodeish?.extensions).toEqual(["x"]);

    const bogus = status.find((s) => s.languageId === "bogus");
    expect(bogus).toMatchObject({ available: false, running: false });
  });

  it("returns a fresh extensions array (callers can't mutate internal state)", () => {
    const m = new LspManager({
      root: "/tmp",
      servers: [{ languageId: "a", command: "node", args: [], extensions: ["x"] }],
    });
    const first = m.status()[0];
    first?.extensions.push("mutated");
    expect(m.status()[0]?.extensions).toEqual(["x"]);
  });
});
