import { modelDescription, resolveModelId, saveSettings } from "@nova/runtime";
import { dim, green } from "../colors.js";
import { refreshBanner, type CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/model";

/**
 * Switch the active model and persist to nova.config.json. `name` is a key in
 * settings.models (a configured tier like "flash"/"pro") or a bare model id. We
 * rebuild both the tracked main model and the non-tracked predict mirror and
 * refresh the banner — and also write the new default to nova.config.json so the
 * choice survives restarts. Sub-agents read ctx.settings.model lazily, so they
 * follow the switch when nothing more specific is set.
 */
function applyModel(ctx: CliContext, name: string): void {
  ctx.settings.model = name;
  ctx.model = ctx.buildModel(name);
  ctx.predictModel = ctx.buildModel(name, false);
  refreshBanner(ctx);
  const resolved = resolveModelId(ctx.settings, name);
  const suffix = resolved === name ? "" : dim(` (${resolved})`);
  saveSettings({ model: name }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`failed to save settings: ${msg}`, { kind: "error", title: TITLE });
  });
  ctx.screen.card(`${dim("model set to")} ${name}${suffix}`, {
    title: TITLE,
  });
}

export async function handleModel(ctx: CliContext, arg: string): Promise<void> {
  // Explicit arg switches directly (accepts a tier name or a bare id).
  if (arg) {
    applyModel(ctx, arg);
    return;
  }

  const names = Object.keys(ctx.settings.models);
  if (names.length === 0) {
    ctx.screen.card(
      `${dim("current model:")} ${ctx.settings.model}\n${dim(
        'no tiers configured — add a "models" map to nova.config.json, or run',
      )} /model <id>`,
      { title: TITLE },
    );
    return;
  }

  // No arg → vertical list of configured tiers, current one marked. The active
  // model may be stored as a bare id (e.g. "deepseek-v4-pro") rather than the
  // tier key ("pro"), so match on the resolved id to mark the right row.
  const activeId = resolveModelId(ctx.settings, ctx.settings.model);
  const currentIdx = names.findIndex((n) => resolveModelId(ctx.settings, n) === activeId);
  const pick = await ctx.screen.pickOne<string>({
    items: names,
    header: dim("select model:"),
    footer: dim("↑↓ navigate · enter confirm · esc cancel"),
    pageSize: 10,
    initialIndex: currentIdx >= 0 ? currentIdx : 0,
    render: (name, isSelected) => {
      const resolved = resolveModelId(ctx.settings, name);
      const marker = resolved === activeId ? green("*") : " ";
      const desc = modelDescription(ctx.settings, name);
      // Always show the resolved model id (when different from alias) AND the
      // description so the user sees all three: alias, concrete model, and blurb.
      let detail = "";
      if (resolved !== name) detail += `  ${dim(resolved)}`;
      if (desc) detail += `  ${dim(`— ${desc}`)}`;
      return `${pickerArrow(isSelected)} ${marker} ${name}${detail}`;
    },
  });
  if (!pick) {
    ctx.screen.card(dim("cancelled."), { title: TITLE });
    return;
  }
  applyModel(ctx, pick);
}
