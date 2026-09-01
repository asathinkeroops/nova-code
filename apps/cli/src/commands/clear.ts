import { createSession } from "@nova/base";
import { refreshBanner, type CliContext } from "../context.js";
import { t } from "../i18n/index.js";
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
    ctx.screen.card(t.clear.alreadyFresh(ctx.session.id), {
      kind: "info",
      title: "/clear",
    });
    return;
  }

  const fresh = await createSession({
    workspace: ctx.workspace,
    ...(ctx.settings.sessionDir ? { rootOverride: ctx.settings.sessionDir } : {}),
  });
  await switchToSession(ctx, fresh, {
    title: "/clear",
    resumed: false,
    emptyCard: t.clear.startedFresh(fresh.id),
  });
}
