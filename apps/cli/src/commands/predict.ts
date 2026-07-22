import { saveSettings } from "@nova/runtime";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";

const TITLE = "/predict";

export async function handlePredict(ctx: CliContext, arg: string): Promise<void> {
  if (!arg) {
    ctx.screen.card(
      `${dim(t.predict.label)} ${ctx.settings.predict.enabled ? t.predict.on : t.predict.off}`,
      { title: TITLE },
    );
    return;
  }
  if (arg !== "on" && arg !== "off") {
    ctx.screen.card(t.predict.expected, { kind: "error", title: TITLE });
    return;
  }
  ctx.settings.predict.enabled = arg === "on";
  if (!ctx.settings.predict.enabled) ctx.nextPlaceholder = "";
  try {
    await saveSettings({ predict: ctx.settings.predict });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(t.predict.saveFailed(msg), { kind: "error", title: TITLE });
  }
  ctx.screen.card(`${dim(t.predict.setTo)} ${arg}`, { title: TITLE });
}
