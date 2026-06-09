import { createSession } from "@nova/runtime";
import { refreshBanner, type CliContext } from "../context.js";
import { switchToSession } from "../session.js";

/**
 * Start a fresh session. If the current session already has no history we just
 * reuse it (reset the screen) rather than spawning an empty session directory.
 * Otherwise we switch to a freshly created empty session and leave the current
 * one intact on disk, so it stays resumable via /resume.
 */
export async function handleClear(ctx: CliContext): Promise<void> {
  ctx.nextPlaceholder = "";

  if (ctx.screen.getMessages().length === 0) {
    await ctx.screen.reset();
    refreshBanner(ctx);
    ctx.screen.card(`already on a fresh session ${ctx.session.id}`, {
      kind: "info",
      title: "/clear",
    });
    return;
  }

  const fresh = await createSession(ctx.settings.sessionDir);
  await switchToSession(ctx, fresh, {
    title: "/clear",
    resumed: false,
    emptyCard: `started fresh session ${fresh.id}`,
  });
}
