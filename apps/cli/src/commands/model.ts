import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import type { CliContext } from "../context.js";

export async function handleModel(ctx: CliContext, arg: string): Promise<void> {
  process.stdout.write("\n");
  if (!arg) {
    process.stdout.write(`${dim("model:")} ${ctx.settings.model}\n`);
    return;
  }
  ctx.settings.model = arg;
  ctx.model = ctx.buildModel(arg);
  try {
    await saveSettings({ model: arg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
  process.stdout.write(`${dim("model set to")} ${arg}\n`);
}
