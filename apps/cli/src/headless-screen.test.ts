import { describe, expect, it } from "vitest";
import { HeadlessScreen } from "./headless-screen.js";

describe("HeadlessScreen", () => {
  it("reports the configured permission mode", () => {
    expect(new HeadlessScreen().getPermissionMode()).toBe("default");
    expect(new HeadlessScreen({ permissionMode: "plan" }).getPermissionMode()).toBe("plan");
    expect(
      new HeadlessScreen({ permissionMode: "acceptEdits" }).getPermissionMode(),
    ).toBe("acceptEdits");
  });

  it("denies approval prompts by default and allows them when policy is allow", async () => {
    await expect(new HeadlessScreen().promptApproval()).resolves.toBe("no");
    await expect(
      new HeadlessScreen({ approvalPolicy: "deny" }).promptApproval(),
    ).resolves.toBe("no");
    await expect(
      new HeadlessScreen({ approvalPolicy: "allow" }).promptApproval(),
    ).resolves.toBe("always-allow");
  });

  it("returns a cancelled response for askUser (no human to answer)", async () => {
    const screen = new HeadlessScreen();
    const res = await screen.askUser({
      questions: [
        { question: "q1", header: "h1", options: [{ label: "a" }], multiSelect: false },
        { question: "q2", header: "h2", options: [{ label: "b" }], multiSelect: true },
      ],
    });
    expect(res.cancelled).toBe(true);
    expect(res.answers).toEqual([{ selected: [] }, { selected: [] }]);
  });

  it("takeInput resolves null so the REPL loop never blocks", async () => {
    await expect(new HeadlessScreen().takeInput()).resolves.toBeNull();
  });

  it("startSpinner returns an inert handle", () => {
    const handle = new HeadlessScreen().startSpinner();
    expect(handle.elapsedMs()).toBe(0);
    expect(() => handle.stop()).not.toThrow();
    expect(typeof handle.label()).toBe("string");
  });

  it("mount/unmount/reset are inert (no terminal attached)", async () => {
    const screen = new HeadlessScreen();
    expect(() => screen.mount()).not.toThrow();
    await expect(screen.unmount()).resolves.toBeUndefined();
    await expect(screen.reset()).resolves.toBeUndefined();
  });
});
