import { saveSettings } from "@nova/runtime";
import { accent, dim, green, red, yellow } from "../colors.js";
import type { CliContext } from "../context.js";
import { installPlugin, resolvePluginSource, uninstallPlugin } from "../plugins/install.js";
import { loadMarketplace, marketplacePluginSource } from "../plugins/marketplace.js";

const TITLE = "/plugin";

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
] as const;

/**
 * Inspect and toggle loaded plugins. `list` (the default) shows each loaded
 * plugin and what it contributed; `enable`/`disable <name>` persist an opt-out
 * to settings.plugins.disabled — because plugin skills feed the prefix-cached
 * system prompt, toggles take effect on the NEXT session, not mid-session.
 */
export async function handlePlugin(ctx: CliContext, args: string): Promise<void> {
  const trimmed = args.trim();
  const [sub, ...rest] = trimmed.split(/\s+/);
  const name = rest.join(" ");

  if (sub === "marketplace") {
    await handleMarketplace(ctx, rest);
    return;
  }

  if (sub === "install") {
    if (!name) {
      ctx.screen.card(dim("usage: /plugin install <path | owner/repo | git-url | name@market>"), {
        title: TITLE,
      });
      return;
    }
    try {
      // `name@market` installs from a registered marketplace; otherwise `name`
      // is a direct source (path / github slug / git url).
      let source;
      if (name.includes("@")) {
        const [pluginName, market] = name.split("@", 2);
        const marketSource = ctx.settings.plugins.marketplaces[market!];
        if (!marketSource) throw new Error(`unknown marketplace "${market}" (add it first)`);
        const { catalog, root } = await loadMarketplace(market!, marketSource);
        source = marketplacePluginSource(catalog, root, pluginName!);
      } else {
        source = resolvePluginSource(name);
      }
      const result = await installPlugin(source);
      ctx.settings.plugins.installed[result.name] = result.source;
      await saveSettings({ plugins: ctx.settings.plugins });
      ctx.screen.card(
        `installed ${accent(result.name)}\n` +
          dim(`from ${JSON.stringify(result.source)}\n`) +
          dim("takes effect on the next session (restart nova or /resume)."),
        { title: TITLE, kind: "warn" },
      );
    } catch (err) {
      ctx.screen.card(red(err instanceof Error ? err.message : String(err)), {
        title: TITLE,
        kind: "error",
      });
    }
    return;
  }

  if (sub === "uninstall") {
    if (!name) {
      ctx.screen.card(dim("usage: /plugin uninstall <name>"), { title: TITLE });
      return;
    }
    await uninstallPlugin(name);
    delete ctx.settings.plugins.installed[name];
    await saveSettings({ plugins: ctx.settings.plugins });
    ctx.screen.card(
      `uninstalled ${accent(name)}\n` + dim("takes effect on the next session."),
      { title: TITLE, kind: "warn" },
    );
    return;
  }

  if (sub === "enable" || sub === "disable") {
    if (!name) {
      ctx.screen.card(dim(`usage: /plugin ${sub} <name>`), { title: TITLE });
      return;
    }
    const disabled = new Set(ctx.settings.plugins.disabled);
    if (sub === "disable") disabled.add(name);
    else disabled.delete(name);
    ctx.settings.plugins.disabled = [...disabled];
    await saveSettings({ plugins: ctx.settings.plugins });
    ctx.screen.card(
      `${sub === "disable" ? "disabled" : "enabled"} plugin ${accent(name)}\n` +
        dim("takes effect on the next session (restart nova or /resume)."),
      { title: TITLE, kind: "warn" },
    );
    return;
  }

  // Default: list.
  if (!ctx.settings.plugins.enabled) {
    ctx.screen.card(dim("plugins are disabled (settings.plugins.enabled = false)."), {
      title: TITLE,
    });
    return;
  }
  if (ctx.plugins.length === 0) {
    ctx.screen.card(
      dim("no plugins loaded. drop a plugin under .nova/plugins/ or ~/.nova/plugins/."),
      { title: TITLE },
    );
    return;
  }

  const lines: string[] = [];
  for (const p of ctx.plugins) {
    const hookCount = p.hooks ? HOOK_EVENTS.reduce((n, e) => n + p.hooks![e].length, 0) : 0;
    const parts = [
      p.commands.length > 0 ? `${p.commands.length} cmd` : "",
      p.agents.length > 0 ? `${p.agents.length} agent` : "",
      p.skills.length > 0 ? `${p.skills.length} skill` : "",
      hookCount > 0 ? `${hookCount} hook` : "",
      Object.keys(p.mcpServers).length > 0 ? `${Object.keys(p.mcpServers).length} mcp` : "",
      p.lspServers.length > 0 ? `${p.lspServers.length} lsp` : "",
      p.tools.length > 0 ? `${p.tools.length} tool` : "",
      p.binDirs.length > 0 ? "bin" : "",
    ].filter(Boolean);
    const version = p.manifest.version ? dim(` v${p.manifest.version}`) : "";
    lines.push(`  ${green("●")} ${accent(p.manifest.name)}${version}  ${dim(`[${p.source}]`)}`);
    if (parts.length > 0) lines.push(`    ${dim(parts.join(" · "))}`);
    else lines.push(`    ${dim("(no contributions)")}`);
    if (p.ignored.length > 0) {
      lines.push(`    ${yellow(`ignored: ${p.ignored.map((i) => i.kind).join(", ")}`)}`);
    }
  }
  lines.push("");
  lines.push(dim(`${ctx.plugins.length} plugin(s) loaded · /plugin disable <name> to opt out`));

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}

/** `/plugin marketplace add|list|remove` — manage registered plugin catalogs. */
async function handleMarketplace(ctx: CliContext, rest: string[]): Promise<void> {
  const [action, ...a] = rest;
  const markets = ctx.settings.plugins.marketplaces;

  if (action === "add") {
    // `add <name> <source>` or `add <source>` (name comes from the catalog).
    const [arg1, arg2] = a;
    if (!arg1) {
      ctx.screen.card(dim("usage: /plugin marketplace add [<name>] <source>"), { title: TITLE });
      return;
    }
    try {
      const explicitName = arg2 ? arg1 : undefined;
      const source = arg2 ?? arg1;
      const { catalog } = await loadMarketplace(explicitName ?? "marketplace", source);
      const marketName = explicitName ?? catalog.name;
      markets[marketName] = source;
      await saveSettings({ plugins: ctx.settings.plugins });
      ctx.screen.card(
        `added marketplace ${accent(marketName)} (${catalog.plugins.length} plugins)\n` +
          dim(`install with /plugin install <name>@${marketName}`),
        { title: TITLE },
      );
    } catch (err) {
      ctx.screen.card(red(err instanceof Error ? err.message : String(err)), {
        title: TITLE,
        kind: "error",
      });
    }
    return;
  }

  if (action === "remove") {
    const [marketName] = a;
    if (!marketName || !markets[marketName]) {
      ctx.screen.card(dim(`usage: /plugin marketplace remove <name>`), { title: TITLE });
      return;
    }
    delete markets[marketName];
    await saveSettings({ plugins: ctx.settings.plugins });
    ctx.screen.card(`removed marketplace ${accent(marketName)}`, { title: TITLE });
    return;
  }

  // Default: list.
  const names = Object.keys(markets);
  if (names.length === 0) {
    ctx.screen.card(dim("no marketplaces registered. /plugin marketplace add <source>"), {
      title: TITLE,
    });
    return;
  }
  const lines = names.map((n) => `  ${accent(n)}  ${dim(JSON.stringify(markets[n]))}`);
  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
