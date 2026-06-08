import { persist, type CliContext } from "../context.js";
import { clearDisplaySidecar } from "../display-sidecar.js";

export async function handleClear(ctx: CliContext): Promise<void> {
  ctx.screen.setMessages([]);
  ctx.nextPlaceholder = "";
  await persist(ctx);
  await clearDisplaySidecar(ctx.session.dir);
  await ctx.screen.reset();
}
