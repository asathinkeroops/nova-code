import { persist, type CliContext } from "../context.js";
import { clearDisplayOverrides } from "../display-overrides.js";

export async function handleClear(ctx: CliContext): Promise<void> {
  ctx.screen.setMessages([]);
  ctx.nextPlaceholder = "";
  await persist(ctx);
  await clearDisplayOverrides(ctx.session.dir);
  await ctx.screen.reset();
}
