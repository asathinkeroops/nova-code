import { dim, green, red } from "../colors.js";
import { manualCompact } from "../compactor.js";
import { persist, stopSpinner, type CliContext } from "../context.js";

export async function handleCompact(ctx: CliContext, focus: string): Promise<void> {
  if (ctx.messages.length === 0) {
    ctx.screen.card(dim("nothing to compact (empty history)."), { title: "/compact" });
    return;
  }
  ctx.screen.print("\n");
  const spinner = ctx.screen.startSpinner("Compacting");
  ctx.spinner = spinner;
  try {
    const result = await manualCompact(ctx.messages, {
      settings: ctx.settings,
      getModel: () => ctx.model,
      getSessionDir: () => ctx.session.dir,
      ...(focus ? { focus } : {}),
    });
    ctx.messages = result.messages;
    ctx.screen.setMessages(ctx.messages);
    ctx.screen.clearCards();
    ctx.nextPlaceholder = "";
    await persist(ctx);
    const seconds = (spinner.elapsedMs() / 1000).toFixed(1);
    const tail = result.transcriptPath ? ` · snapshot: ${result.transcriptPath}` : "";
    stopSpinner(
      ctx,
      `${green("✓")} ${dim(`compacted · ${seconds}s · ${result.before} → ${result.after} msgs${tail}`)}`,
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
    stopSpinner(ctx, red(`✗ compact failed · ${msg}`));
    ctx.logger.error({ err: msg }, "manual /compact failed");
  }
}
