import {
  modelDescription,
  resolveModelId,
  resolveThinkingLevel,
  saveSettings,
} from "@nova/runtime";
import { dim, green } from "../colors.js";
import { refreshBanner, thinkingLevelLabel, type CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/model";

/**
 * Switch the active model and persist to nova.config.json. `name` is a key in
 * settings.models (a configured tier like "lite"/"pro"/"max") or a bare model id. We
 * rebuild both the tracked main model and the non-tracked predict mirror and
 * refresh the banner — and also write the new default to nova.config.json so the
 * choice survives restarts. Sub-agents read ctx.settings.model lazily, so they
 * follow the switch when nothing more specific is set.
 */
function applyModel(ctx: CliContext, name: string): void {
  ctx.settings.model = name;
  ctx.model = ctx.buildModel(name);
  ctx.predictModel = ctx.buildModel(name, false);
  // Re-seed the reasoning depth from the new tier's per-tier `thinking` level
  // (the lite/pro/max ladder), clearing any ad-hoc /effort budget override so
  // the tier's level takes hold. A tier that doesn't opt in leaves the current
  // level untouched. The tier's level is not persisted to thinking.level — it
  // lives in the model profile, and saving `model` below is enough to restore
  // it next launch.
  const tierThinking = resolveThinkingLevel(ctx.settings, name);
  if (tierThinking) {
    ctx.thinkingLevel = tierThinking;
    ctx.thinkingBudgetOverride = undefined;
    ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  }
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
  const names = Object.keys(ctx.settings.models);

  // Explicit arg switches directly. It must name a configured tier — model
  // selection is alias-only, so a bare model id (or a typo) is rejected rather
  // than silently set as an unresolvable model.
  if (arg) {
    if (!Object.prototype.hasOwnProperty.call(ctx.settings.models, arg)) {
      ctx.screen.card(
        `${dim("unknown tier")} ${arg}${
          names.length ? `\n${dim("configured tiers:")} ${names.join(", ")}` : ""
        }`,
        { kind: "error", title: TITLE },
      );
      return;
    }
    applyModel(ctx, arg);
    return;
  }

  if (names.length === 0) {
    ctx.screen.card(
      `${dim("current model:")} ${ctx.settings.model}\n${dim(
        'no tiers configured — add a "models" map to nova.config.json',
      )}`,
      { title: TITLE },
    );
    return;
  }

  // No arg → vertical list of configured tiers, current one marked. Matched by
  // tier KEY (alias): distinct tiers can share one concrete id (e.g. pro/max both
  // → deepseek-v4-pro, differing only in per-tier thinking), so id-matching would
  // mark BOTH rows and pick the wrong one. `model` is always a tier key.
  const currentIdx = names.findIndex((n) => n === ctx.settings.model);
  const pick = await ctx.screen.pickOne<string>({
    items: names,
    header: dim("select model:"),
    footer: dim("↑↓ navigate · enter confirm · esc cancel"),
    pageSize: 10,
    initialIndex: currentIdx >= 0 ? currentIdx : 0,
    render: (name, isSelected) => {
      const resolved = resolveModelId(ctx.settings, name);
      const marker = name === ctx.settings.model ? green("*") : " ";
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
