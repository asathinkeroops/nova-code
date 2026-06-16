import { modelDescription, resolveModelId } from "@nova/runtime";
import { dim, green } from "../colors.js";
import { refreshBanner, type CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/model";

/**
 * Switch the active model for THIS SESSION only. `name` is a key in
 * settings.models (a configured tier like "flash"/"pro") or a bare model id. We
 * rebuild both the tracked main model and the non-tracked predict mirror and
 * refresh the banner — but intentionally do NOT persist to nova.config.json, so
 * the user's configured default is left untouched (next launch reverts to it).
 * Sub-agents read ctx.settings.model lazily, so they follow the switch when
 * nothing more specific is set.
 */
function applyModel(ctx: CliContext, name: string): void {
  ctx.settings.model = name;
  ctx.model = ctx.buildModel(name);
  ctx.predictModel = ctx.buildModel(name, false);
  refreshBanner(ctx);
  const resolved = resolveModelId(ctx.settings, name);
  const suffix = resolved === name ? "" : dim(` (${resolved})`);
  ctx.screen.card(`${dim("model set to")} ${name}${suffix} ${dim("(this session)")}`, {
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
      // Prefer the human blurb; fall back to the raw id when a tier has none.
      const detail = desc ? `  ${dim(`— ${desc}`)}` : resolved === name ? "" : `  ${dim(resolved)}`;
      return `${pickerArrow(isSelected)} ${marker} ${name}${detail}`;
    },
  });
  if (!pick) {
    ctx.screen.card(dim("cancelled."), { title: TITLE });
    return;
  }
  applyModel(ctx, pick);
}
