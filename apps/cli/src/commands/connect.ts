import {
  activeProviderProfile,
  DEFAULT_MODEL_TIER,
  REQUIRED_MODEL_TIERS,
  resolveApiKey,
  resolveModelId,
  resolveThinkingLevel,
  saveSettings,
  type Settings,
} from "@nova/base";
import { accent, ACCENT_HEX, dim, green } from "../colors.js";
import { refreshBalance, refreshBanner, thinkingLevelLabel, type CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { settingsReadiness, type SettingsReadiness } from "../startup-readiness.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/connect";

function notice(ctx: CliContext, lines: string[]): Promise<void> {
  return ctx.screen.viewer({
    lines,
    header: accent(TITLE),
    footer: dim(t.common.footerClose),
    border: false,
    topRuleColor: ACCENT_HEX,
  });
}

function readinessMessage(name: string, state: SettingsReadiness): string | null {
  switch (state) {
    case "ready":
      return null;
    case "missing-api-key":
      return t.connect.missingApiKey(name);
    case "missing-models":
      return t.connect.missingModels(name);
    case "missing-base-url":
      return t.connect.missingBaseUrl(name);
  }
}

/** Resolve and validate a configured connection without mutating the live context. */
function candidateFor(ctx: CliContext, name: string): { model: string } | { error: string } {
  const provider = ctx.settings.providers.find((entry) => entry.name === name);
  if (!provider) return { error: t.connect.unknownProvider(name) };

  const models = provider.models;
  const modelNames = Object.keys(models);
  if (modelNames.length === 0) return { error: t.connect.missingModels(name) };
  const missing = REQUIRED_MODEL_TIERS.filter(
    (tier) => !Object.prototype.hasOwnProperty.call(models, tier),
  );
  if (missing.length > 0) return { error: t.connect.missingTiers(name, missing.join(", ")) };

  // Preserve the current tier when both connections expose it. Custom tiers
  // need not exist everywhere, so fall back to the required `pro` rung.
  const model = Object.prototype.hasOwnProperty.call(models, ctx.settings.model)
    ? ctx.settings.model
    : DEFAULT_MODEL_TIER;
  const settings: Settings = { ...ctx.settings, currentProvider: name, model };
  const problem = readinessMessage(name, settingsReadiness(settings));
  return problem ? { error: problem } : { model };
}

async function applyConnection(ctx: CliContext, name: string): Promise<void> {
  const candidate = candidateFor(ctx, name);
  if ("error" in candidate) {
    await notice(ctx, [
      candidate.error,
      dim(t.connect.configuredProviders(ctx.settings.providers.map((p) => p.name).join(", "))),
    ]);
    return;
  }

  if (name === ctx.settings.currentProvider && candidate.model === ctx.settings.model) {
    ctx.screen.card(`${dim(t.connect.alreadyConnected)} ${name}`, { title: TITLE });
    return;
  }

  const previousProvider = ctx.settings.currentProvider;
  const previousModel = ctx.settings.model;
  const previousApiKey = ctx.apiKey;
  ctx.settings.currentProvider = name;
  ctx.settings.model = candidate.model;

  // Construct both clients before persisting. If an endpoint/header is somehow
  // unusable despite config validation, leave both disk and live state alone.
  let model: CliContext["model"];
  let predictModel: CliContext["predictModel"];
  try {
    model = ctx.buildModel(candidate.model);
    predictModel = ctx.buildModel(candidate.model, false);
  } catch (err) {
    ctx.settings.currentProvider = previousProvider;
    ctx.settings.model = previousModel;
    ctx.apiKey = previousApiKey;
    const message = err instanceof Error ? err.message : String(err);
    await notice(ctx, [t.connect.initializeFailed(name, message)]);
    return;
  }

  try {
    await saveSettings({
      currentProvider: name,
      ...(candidate.model !== previousModel ? { model: candidate.model } : {}),
    });
  } catch (err) {
    ctx.settings.currentProvider = previousProvider;
    ctx.settings.model = previousModel;
    ctx.apiKey = previousApiKey;
    const message = err instanceof Error ? err.message : String(err);
    ctx.screen.card(t.connect.saveFailed(message), { kind: "error", title: TITLE });
    return;
  }

  ctx.model = model;
  ctx.predictModel = predictModel;
  ctx.apiKey = resolveApiKey(ctx.settings)!;
  ctx.thinkingLevel = resolveThinkingLevel(ctx.settings, candidate.model);
  ctx.screen.setThinkingLabel(thinkingLevelLabel(ctx));
  // Do not leave the prior provider's balance visible while the new provider's
  // optional probe runs (or when the new profile has no balance endpoint).
  ctx.screen.setAccountBalance(null);
  refreshBanner(ctx);
  void refreshBalance(ctx);

  const modelId = resolveModelId(ctx.settings, candidate.model);
  const profile = activeProviderProfile(ctx.settings) ?? name;
  const profileSuffix = profile === name ? "" : dim(` [${profile}]`);
  const modelSuffix = dim(` · ${candidate.model} (${modelId})`);
  const fallback =
    candidate.model === previousModel ? "" : dim(t.connect.modelFallback(candidate.model));
  ctx.screen.card(
    `${dim(t.connect.connectedTo)} ${green(name)}${profileSuffix}${modelSuffix}${fallback}`,
    { title: TITLE },
  );
}

export async function handleConnect(ctx: CliContext, arg: string): Promise<void> {
  const names = ctx.settings.providers.map((provider) => provider.name);
  if (names.length === 0) {
    await notice(ctx, [dim(t.connect.noProviders)]);
    return;
  }

  // An explicit name is legal only when it exactly matches a configured
  // `providers[].name`. Names may contain spaces, so treat the whole argument
  // as the name instead of tokenizing it.
  if (arg) {
    await applyConnection(ctx, arg);
    return;
  }

  const currentIdx = names.findIndex((name) => name === ctx.settings.currentProvider);
  const pick = await ctx.screen.pickOne<string>({
    items: names,
    header: `${accent(TITLE)}  ${dim(t.connect.selectProvider)}`,
    footer: dim(t.connect.navFooter),
    pageSize: 10,
    initialIndex: currentIdx >= 0 ? currentIdx : 0,
    border: false,
    topRuleColor: ACCENT_HEX,
    render: (name, isSelected) => {
      const provider = ctx.settings.providers.find((entry) => entry.name === name)!;
      const marker = name === ctx.settings.currentProvider ? green("*") : " ";
      const profile = provider.profile ?? provider.name;
      const detail = profile === name ? "" : `  ${dim(`[${profile}]`)}`;
      return `${pickerArrow(isSelected)} ${marker} ${name}${detail}`;
    },
  });
  if (!pick) return;
  await applyConnection(ctx, pick);
}
