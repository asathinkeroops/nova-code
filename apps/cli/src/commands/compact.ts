import { manualCompact } from "@nova/agent";
import { dim } from "../colors.js";
import { persist, stopSpinner, type CliContext } from "../context.js";
import { t } from "../i18n/index.js";

export async function handleCompact(ctx: CliContext, focus: string): Promise<void> {
  const current = ctx.screen.getMessages();
  if (current.length === 0) {
    ctx.screen.card(dim(t.compact.nothingToCompact), { title: "/compact" });
    return;
  }
  const spinner = ctx.screen.startSpinner(t.compact.compacting);
  ctx.spinner = spinner;
  try {
    const pre = await ctx.userHooks.firePreCompact({
      subject: "manual",
      fields: { trigger: "manual", before: current.length },
    });
    if (pre.blocked) {
      stopSpinner(ctx);
      ctx.screen.card(
        t.compact.blocked(pre.reason),
        {
          kind: "warn",
          title: "/compact",
        },
      );
      return;
    }
    // The session's own compaction port — the same instance the loop consults,
    // so manual and automatic compaction cannot drift apart.
    const result = await manualCompact(current, {
      compactor: ctx.compactor,
      ...(focus ? { focus } : {}),
    });
    await ctx.userHooks.fire("PostCompact", {
      subject: "manual",
      fields: {
        trigger: "manual",
        before: result.before,
        after: result.after,
      },
    });
    // Append-only: `result.messages` is the full retained history plus the new
    // <compacted> boundary. The history is NOT truncated (the TUI keeps
    // rendering it; only the model reads the post-boundary slice), so the
    // index-anchored cards stay valid and are left in place.
    ctx.screen.setMessages(result.messages);
    ctx.nextPlaceholder = "";
    await persist(ctx);
    const seconds = (spinner.elapsedMs() / 1000).toFixed(1);
    stopSpinner(ctx);
    ctx.screen.card(t.compact.completed(seconds, result.before, result.after), {
      kind: "info",
      title: "/compact",
    });
    ctx.logger.info(
      {
        before: result.before,
        after: result.after,
        focus: focus || undefined,
      },
      "manual /compact",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stopSpinner(ctx);
    ctx.screen.card(msg, { kind: "error", title: t.compact.failedTitle });
    ctx.logger.error({ err: msg }, "manual /compact failed");
  }
}
