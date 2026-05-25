import { persist, type CliContext } from "../context.js";

export async function handleClear(ctx: CliContext): Promise<void> {
  ctx.screen.setMessages([]);
  ctx.nextPlaceholder = "";
  await persist(ctx);
  await ctx.screen.reset();
}
