import { dim } from "../colors.js";
import { manualCompact } from "../compactor.js";
import { persist, stopSpinner, type CliContext } from "../context.js";

export async function handleCompact(ctx: CliContext, focus: string): Promise<void> {
  const current = ctx.screen.getMessages();
  if (current.length === 0) {
    ctx.screen.card(dim("nothing to compact (empty history)."), { title: "/compact" });
    return;
  }
  const spinner = ctx.screen.startSpinner("Compacting");
  ctx.spinner = spinner;
  try {
    const pre = await ctx.userHooks.firePreCompact({
      subject: "manual",
      fields: { trigger: "manual", before: current.length },
    });
    if (pre.blocked) {
      stopSpinner(ctx);
      ctx.screen.card(
        `compaction blocked by PreCompact hook${pre.reason ? `: ${pre.reason}` : ""}`,
        {
          kind: "warn",
          title: "/compact",
        },
      );
      return;
    }
    const result = await manualCompact(current, {
      settings: ctx.settings,
      // Non-streaming client so the summarizer's tokens don't stream into the
      // live draft / spinner as a phantom assistant turn (it's internal; the
      // result is surfaced via the card below). Follows /model switches.
      getModel: () => ctx.buildModel(ctx.settings.model, false),
      getSessionDir: () => ctx.session.dir,
      ...(focus ? { focus } : {}),
    });
    await ctx.userHooks.fire("PostCompact", {
      subject: "manual",
      fields: {
        trigger: "manual",
        before: result.before,
        after: result.after,
        ...(result.transcriptPath ? { archived_transcript_path: result.transcriptPath } : {}),
      },
    });
    ctx.screen.setMessages(result.messages);
    ctx.screen.clearCards();
    ctx.nextPlaceholder = "";
    await persist(ctx);
    const seconds = (spinner.elapsedMs() / 1000).toFixed(1);
    const tail = result.transcriptPath ? `\nsnapshot: ${result.transcriptPath}` : "";
    stopSpinner(ctx);
    ctx.screen.card(`${seconds}s · ${result.before} → ${result.after} msgs${tail}`, {
      kind: "info",
      title: "/compact",
    });
    ctx.logger.info(
      {
        before: result.before,
        after: result.after,
        transcriptPath: result.transcriptPath,
        focus: focus || undefined,
      },
      "manual /compact",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stopSpinner(ctx);
    ctx.screen.card(msg, { kind: "error", title: "/compact failed" });
    ctx.logger.error({ err: msg }, "manual /compact failed");
  }
}
