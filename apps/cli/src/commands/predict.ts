import { saveSettings } from "@nova/runtime";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/predict";

export async function handlePredict(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    ctx.screen.card(
      `${dim("predict:")} ${ctx.settings.predict.enabled ? "on" : "off"}`,
      { title: TITLE },
    );
    return;
  }
  if (arg !== "on" && arg !== "off") {
    ctx.screen.card("expected on or off", { kind: "error", title: TITLE });
    return;
  }
  ctx.settings.predict.enabled = arg === "on";
  if (!ctx.settings.predict.enabled) ctx.nextPlaceholder = "";
  try {
    await saveSettings({ predict: ctx.settings.predict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to save settings: ${msg}`, { kind: "error", title: TITLE });
  }
  ctx.screen.card(`${dim("predict set to")} ${arg}`, { title: TITLE });
}
