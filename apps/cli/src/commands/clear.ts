import { persist, printBanner, type CliContext } from "../context.js";

export async function handleClear(ctx: CliContext): Promise<void> {
  ctx.messages = [];
  ctx.nextPlaceholder = "";
  await persist(ctx);
  await ctx.screen.reset();
  printBanner(ctx);
}
