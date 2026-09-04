import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@nova/base";
import type { CliContext } from "../context.js";

const { createSession, refreshBanner, switchToSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
  refreshBanner: vi.fn(),
  switchToSession: vi.fn(),
}));

vi.mock("@nova/base", () => ({ createSession }));
vi.mock("../context.js", () => ({ refreshBanner }));
vi.mock("../session.js", () => ({ switchToSession }));

import { handleClear } from "./clear.js";

function makeContext(messages: unknown[]): CliContext {
  return {
    nextPlaceholder: "predicted input",
    workspace: "/repo",
    settings: { sessionDir: "/sessions" },
    session: { id: "current-session" },
    screen: {
      getMessages: vi.fn(() => messages),
      reset: vi.fn(),
      card: vi.fn(),
    },
  } as unknown as CliContext;
}

describe("handleClear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quietly resets an already-empty session", async () => {
    const ctx = makeContext([]);

    await handleClear(ctx);

    expect(ctx.screen.reset).toHaveBeenCalledOnce();
    expect(refreshBanner).toHaveBeenCalledWith(ctx);
    expect(ctx.screen.card).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(ctx.nextPlaceholder).toBe("");
  });

  it("switches a non-empty session without showing a session card", async () => {
    const ctx = makeContext([{ role: "user", content: "hello" }]);
    const fresh = {
      id: "fresh-session",
      dir: "/sessions/fresh-session",
    } as Session;
    createSession.mockResolvedValue(fresh);

    await handleClear(ctx);

    expect(createSession).toHaveBeenCalledWith({
      workspace: "/repo",
      rootOverride: "/sessions",
    });
    expect(switchToSession).toHaveBeenCalledWith(ctx, fresh, {
      title: "/clear",
      resumed: false,
      showSessionCard: false,
    });
    expect(ctx.screen.card).not.toHaveBeenCalled();
    expect(ctx.nextPlaceholder).toBe("");
  });
});
