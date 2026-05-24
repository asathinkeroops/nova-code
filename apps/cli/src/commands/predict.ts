import { saveSettings } from "@nova/runtime";
import { dim, red } from "../colors.js";
import type { CliContext } from "../context.js";

export async function handlePredict(ctx: CliContext, arg: string): Promise<void> {
  ctx.screen.print("\n");
  if (!arg) {
    ctx.screen.print(`${dim("predict:")} ${ctx.settings.predict.enabled ? "on" : "off"}\n`);
    return;
  }
  if (arg !== "on" && arg !== "off") {
    ctx.screen.print(`${red("✗")} ${dim("expected on or off")}\n`);
    return;
  }
  ctx.settings.predict.enabled = arg === "on";
  if (!ctx.settings.predict.enabled) ctx.nextPlaceholder = "";
  try {
    await saveSettings({ predict: ctx.settings.predict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.print(`${red("✗")} ${dim(`failed to save settings: ${msg}`)}\n`);
  }
  ctx.screen.print(`${dim("predict set to")} ${arg}\n`);
}
