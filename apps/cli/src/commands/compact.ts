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
    const result = await manualCompact(current, {
      settings: ctx.settings,
      getModel: () => ctx.model,
      getSessionDir: () => ctx.session.dir,
      ...(focus ? { focus } : {}),
    });
    ctx.screen.setMessages(result.messages);
    ctx.screen.clearCards();
    ctx.nextPlaceholder = "";
    await persist(ctx);
    const seconds = (spinner.elapsedMs() / 1000).toFixed(1);
    const tail = result.transcriptPath ? `\nsnapshot: ${result.transcriptPath}` : "";
    stopSpinner(ctx);
    ctx.screen.card(
      `${seconds}s · ${result.before} → ${result.after} msgs${tail}`,
      { kind: "info", title: "/compact" },
    );
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
