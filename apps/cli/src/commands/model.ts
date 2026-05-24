import { saveSettings } from "@nova/runtime";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/model";

export async function handleModel(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    ctx.screen.card(`${dim("model:")} ${ctx.settings.model}`, { title: TITLE });
    return;
  }
  ctx.settings.model = arg;
  ctx.model = ctx.buildModel(arg);
  try {
    await saveSettings({ model: arg });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to save settings: ${msg}`, { kind: "error", title: TITLE });
  }
  ctx.screen.card(`${dim("model set to")} ${arg}`, { title: TITLE });
}
