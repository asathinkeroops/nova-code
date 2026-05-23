import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import type { CliContext } from "../context.js";

export async function handlePredict(ctx: CliContext, arg: string): Promise<void> {
  process.stdout.write("\n");
  if (!arg) {
    process.stdout.write(`${dim("predict:")} ${ctx.settings.predict.enabled ? "on" : "off"}\n`);
    return;
  }
  if (arg !== "on" && arg !== "off") {
    process.stdout.write(`${red("✗")} ${dim("expected on or off")}\n`);
    return;
  }
  ctx.settings.predict.enabled = arg === "on";
  if (!ctx.settings.predict.enabled) ctx.nextPlaceholder = "";
  try {
    await saveSettings({ predict: ctx.settings.predict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
  process.stdout.write(`${dim("predict set to")} ${arg}\n`);
}
