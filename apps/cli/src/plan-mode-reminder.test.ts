import { describe, expect, it } from "vitest";
import type { MessageParam } from "@nova/core";
import { makePlanModeReminder, type PlanModeReminderHook } from "./plan-mode-reminder.js";
import type { PermissionMode } from "./permissions.js";

const BASE: Parameters<PlanModeReminderHook>[0] = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 100,
};

function payload(messages: MessageParam[]): Parameters<PlanModeReminderHook>[0] {
  return { ...BASE, messages };
}

function textOf(override: { messages?: MessageParam[] } | undefined): string {
  const last = override?.messages?.at(-1);
  const block = Array.isArray(last?.content) ? last?.content[0] : undefined;
  return block && block.type === "text" ? block.text : "";
}

describe("makePlanModeReminder", () => {
  it("says nothing while the mode is unchanged", () => {
    const mode: PermissionMode = "default";
    const hook = makePlanModeReminder(() => mode);
    expect(hook(BASE)).toBeUndefined();
    expect(hook(BASE)).toBeUndefined();
  });

  it("announces entering plan mode once, on the next request", () => {
    let mode: PermissionMode = "default";
    const hook = makePlanModeReminder(() => mode);
    expect(hook(BASE)).toBeUndefined();

    mode = "plan"; // user hits shift+tab between turns — no injection yet
    const out = hook(BASE);
    expect(textOf(out)).toContain("Plan mode is now ON");
    // ...and does not repeat on the following request while still in plan mode.
    expect(hook(BASE)).toBeUndefined();
  });

  it("announces leaving plan mode", () => {
    let mode: PermissionMode = "plan";
    const hook = makePlanModeReminder(() => mode);
    // Seeded from the current mode, so a session that opens in plan mode does
    // not announce on turn 1.
    expect(hook(BASE)).toBeUndefined();

    mode = "default";
    expect(textOf(hook(BASE))).toContain("Plan mode is now OFF");
  });

  it("ignores non-plan transitions (default → acceptEdits → auto)", () => {
    let mode: PermissionMode = "default";
    const hook = makePlanModeReminder(() => mode);
    mode = "acceptEdits";
    expect(hook(BASE)).toBeUndefined();
    mode = "auto";
    expect(hook(BASE)).toBeUndefined();
  });

  it("treats leave→other-mode as a leave (plan → acceptEdits)", () => {
    let mode: PermissionMode = "plan";
    const hook = makePlanModeReminder(() => mode);
    hook(BASE); // seed
    mode = "acceptEdits";
    expect(textOf(hook(BASE))).toContain("Plan mode is now OFF");
  });

  it("appends to the tail without mutating the input messages", () => {
    let mode: PermissionMode = "default";
    const hook = makePlanModeReminder(() => mode);
    mode = "plan";
    const input: MessageParam[] = [{ role: "user", content: "keep me" }];
    const out = hook(payload(input));
    expect(input).toHaveLength(1); // untouched
    expect(out?.messages).toHaveLength(2);
    expect(out?.messages?.[0]).toEqual({ role: "user", content: "keep me" });
    expect(out?.messages?.at(-1)?.meta).toEqual({ synthetic: true, kind: "plan-mode" });
  });

  it("net-zero toggles between two requests inject nothing", () => {
    let mode: PermissionMode = "default";
    const hook = makePlanModeReminder(() => mode);
    // enter then leave while idle; at the next request the effective state is
    // unchanged from what the model last saw.
    mode = "default"; // (represents plan→default net change back to default)
    expect(hook(BASE)).toBeUndefined();
  });
});
