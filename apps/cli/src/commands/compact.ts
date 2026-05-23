import { dim, green, red } from "../colors.js";
import { manualCompact } from "../compactor.js";
import { persist, stopSpinner, type CliContext } from "../context.js";

export async function handleCompact(ctx: CliContext, focus: string): Promise<void> {
  process.stdout.write("\n");
  if (ctx.messages.length === 0) {
    process.stdout.write(`${dim("nothing to compact (empty history).")}\n`);
    return;
  }
  const spinner = ctx.screen.startSpinner("compacting");
  ctx.spinner = spinner;
  try {
    const result = await manualCompact(ctx.messages, {
      settings: ctx.settings,
      getModel: () => ctx.model,
      getSessionDir: () => ctx.session.dir,
      ...(focus ? { focus } : {}),
    });
    ctx.messages = result.messages;
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
    await ctx.transcript.append({
      kind: "compact",
      data: {
        before: result.before,
        after: result.after,
        transcriptPath: result.transcriptPath,
        focus: focus || undefined,
        trigger: "manual",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stopSpinner(ctx, red(`✗ compact failed · ${msg}`));
    ctx.logger.error({ err: msg }, "manual /compact failed");
  }
}
