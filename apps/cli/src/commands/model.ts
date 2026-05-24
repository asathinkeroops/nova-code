import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import type { CliContext } from "../context.js";

export async function handleModel(ctx: CliContext, arg: string): Promise<void> {
  ctx.screen.print("\n");
  if (!arg) {
    ctx.screen.print(`${dim("model:")} ${ctx.settings.model}\n`);
    return;
  }
  ctx.settings.model = arg;
  ctx.model = ctx.buildModel(arg);
  try {
    await saveSettings({ model: arg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.print(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
  ctx.screen.print(`${dim("model set to")} ${arg}\n`);
}
