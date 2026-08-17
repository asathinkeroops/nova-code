import { Command } from "commander";
import { loadSettings, saveSettings, type Settings } from "@nova/base";
import { cyan, dim, green, red, yellow } from "./colors.js";
import {
  DEFAULT_PLUGIN_CACHE_DIR,
  installPlugin,
  resolvePluginSource,
  uninstallPlugin,
} from "./plugins/install.js";
import { loadMarketplace, marketplacePluginSource } from "./plugins/marketplace.js";
import { loadPlugins, type LoadedPlugin } from "./plugins/loader.js";

/**
 * `nova plugin` — a Claude Code–compatible CLI for installing and managing
 * plugins straight from the shell, without opening the REPL. Mirrors the
 * `nova mcp` command (and `claude plugin`): fetching/materializing sources and
 * editing `plugins` in `~/.nova/nova.config.json` belong here, not in a slash
 * command. The in-REPL `/plugin` menu is left for inspecting loaded plugins and
 * quick enable/disable toggles.
 *
 * Subcommands mirror `claude plugin`:
 *   nova plugin install <path | owner/repo | git-url | name@marketplace>
 *   nova plugin uninstall <name>
 *   nova plugin list
 *   nova plugin enable <name>
 *   nova plugin disable <name>
 *   nova plugin marketplace add [<name>] <source>
 *   nova plugin marketplace list
 *   nova plugin marketplace remove <name>
 */

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

/** Note appended after any mutation: plugin skills feed the prefix-cached prompt. */
const NEXT_SESSION = "  takes effect on the next session (restart nova or /resume).";

function fail(message: string): never {
  process.stderr.write(`${red("✗")} ${message}\n`);
  process.exit(1);
}

/**
 * Classify an install spec. `name@marketplace` resolves from a registered
 * catalog only when the suffix after the LAST `@` is a known marketplace —
 * otherwise the spec is a direct source, so `git@github.com:o/r.git` (which
 * contains an `@`) still routes to `resolvePluginSource` instead of a bogus
 * marketplace lookup.
 */
export function classifyInstallSpec(
  spec: string,
  marketplaces: Record<string, unknown>,
): { kind: "marketplace"; pluginName: string; market: string } | { kind: "direct" } {
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    const market = spec.slice(at + 1);
    if (Object.prototype.hasOwnProperty.call(marketplaces, market)) {
      return { kind: "marketplace", pluginName: spec.slice(0, at), market };
    }
  }
  return { kind: "direct" };
}

/** Persist the mutated `plugins` block, preserving every other config key. */
async function persist(settings: Settings): Promise<void> {
  await saveSettings({ plugins: settings.plugins });
}

async function installCmd(spec: string): Promise<void> {
  const settings = await loadSettings();
  try {
    const classified = classifyInstallSpec(spec, settings.plugins.marketplaces);
    let source;
    if (classified.kind === "marketplace") {
      const marketSource = settings.plugins.marketplaces[classified.market]!;
      const { catalog, root } = await loadMarketplace(classified.market, marketSource);
      source = marketplacePluginSource(catalog, root, classified.pluginName);
    } else {
      source = resolvePluginSource(spec);
    }
    const result = await installPlugin(source);
    settings.plugins.installed[result.name] = result.source;
    await persist(settings);
    process.stdout.write(
      `${green("✓")} Installed plugin ${cyan(result.name)} ` +
        dim(`from ${JSON.stringify(result.source)}\n`) +
        dim(`${NEXT_SESSION}\n`),
    );
    if (!settings.plugins.enabled) {
      process.stdout.write(
        dim(`  note: plugins are disabled — set settings.plugins.enabled=true to load it.\n`),
      );
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function uninstallCmd(name: string): Promise<void> {
  const settings = await loadSettings();
  await uninstallPlugin(name);
  delete settings.plugins.installed[name];
  await persist(settings);
  process.stdout.write(
    `${green("✓")} Uninstalled plugin ${cyan(name)}\n` + dim(`${NEXT_SESSION}\n`),
  );
}

async function toggleCmd(name: string, action: "enable" | "disable"): Promise<void> {
  const settings = await loadSettings();
  const disabled = new Set(settings.plugins.disabled);
  if (action === "disable") disabled.add(name);
  else disabled.delete(name);
  settings.plugins.disabled = [...disabled];
  await persist(settings);
  process.stdout.write(
    `${green("✓")} ${action === "disable" ? "Disabled" : "Enabled"} plugin ${cyan(name)}\n` +
      dim(`${NEXT_SESSION}\n`),
  );
}

/** One-line summary of what a loaded plugin contributes. */
function contributions(p: LoadedPlugin): string {
  const hookCount = p.hooks ? HOOK_EVENTS.reduce((n, e) => n + p.hooks![e].length, 0) : 0;
  const parts = [
    p.commands.length > 0 ? `${p.commands.length} cmd` : "",
    p.agents.length > 0 ? `${p.agents.length} agent` : "",
    p.skills.length > 0 ? `${p.skills.length} skill` : "",
    hookCount > 0 ? `${hookCount} hook` : "",
    Object.keys(p.mcpServers).length > 0 ? `${Object.keys(p.mcpServers).length} mcp` : "",
    p.lspServers.length > 0 ? `${p.lspServers.length} lsp` : "",
    p.binDirs.length > 0 ? "bin" : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "(no contributions)";
}

async function listCmd(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.plugins.enabled) {
    process.stdout.write(dim("Plugins are disabled (settings.plugins.enabled = false).\n"));
    return;
  }
  // Scan the same roots the REPL does at startup (project + user dirs + cache).
  const { plugins, errors } = await loadPlugins({
    cwd: process.cwd(),
    projectDirs: settings.plugins.projectDirs,
    userDirs: [...settings.plugins.userDirs, DEFAULT_PLUGIN_CACHE_DIR],
    disabled: settings.plugins.disabled,
  });
  if (plugins.length === 0) {
    process.stdout.write(dim("No plugins loaded. Install one with `nova plugin install <src>`.\n"));
  }
  for (const p of plugins) {
    const version = p.manifest.version ? dim(` v${p.manifest.version}`) : "";
    process.stdout.write(
      `${green("●")} ${cyan(p.manifest.name)}${version}  ${dim(`[${p.source}]`)}\n`,
    );
    process.stdout.write(`  ${dim(contributions(p))}\n`);
    if (p.ignored.length > 0) {
      process.stdout.write(`  ${yellow(`ignored: ${p.ignored.map((i) => i.kind).join(", ")}`)}\n`);
    }
  }
  const disabled = settings.plugins.disabled;
  if (disabled.length > 0) {
    process.stdout.write(dim(`\nDisabled: ${disabled.join(", ")}\n`));
  }
  for (const e of errors) {
    process.stderr.write(`${red("✗")} ${e.dir}: ${e.message}\n`);
  }
}

async function marketplaceAdd(arg1: string | undefined, arg2: string | undefined): Promise<void> {
  if (!arg1) fail("usage: nova plugin marketplace add [<name>] <source>");
  const settings = await loadSettings();
  try {
    // `add <name> <source>` or `add <source>` (name comes from the catalog).
    const explicitName = arg2 ? arg1 : undefined;
    const source = arg2 ?? arg1;
    const { catalog } = await loadMarketplace(explicitName ?? "marketplace", source);
    const marketName = explicitName ?? catalog.name;
    settings.plugins.marketplaces[marketName] = source;
    await persist(settings);
    process.stdout.write(
      `${green("✓")} Added marketplace ${cyan(marketName)} ` +
        dim(`(${catalog.plugins.length} plugins)\n`) +
        dim(`  install with \`nova plugin install <name>@${marketName}\`\n`),
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function marketplaceRemove(name: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings.plugins.marketplaces[name]) fail(`no marketplace named "${name}"`);
  delete settings.plugins.marketplaces[name];
  await persist(settings);
  process.stdout.write(`${green("✓")} Removed marketplace ${cyan(name)}\n`);
}

async function marketplaceList(): Promise<void> {
  const settings = await loadSettings();
  const markets = settings.plugins.marketplaces;
  const names = Object.keys(markets).sort();
  if (names.length === 0) {
    process.stdout.write(
      dim("No marketplaces registered. Add one with `nova plugin marketplace add <source>`.\n"),
    );
    return;
  }
  const width = Math.min(24, Math.max(...names.map((n) => n.length)));
  for (const name of names) {
    process.stdout.write(`${cyan(name.padEnd(width))}  ${dim(JSON.stringify(markets[name]))}\n`);
  }
}

/**
 * Build the `plugin` subcommand tree. Attached to the root program in index.ts
 * so `nova plugin …` runs standalone (no REPL, no agent context) and exits.
 */
export function buildPluginCommand(): Command {
  const plugin = new Command("plugin").description("Install and manage plugins");

  plugin
    .command("install")
    .description("Install a plugin from a path, github repo, git url, or marketplace")
    .argument("<spec>", "path | owner/repo[#ref] | git-url | name@marketplace")
    .action((spec: string) => installCmd(spec));

  plugin
    .command("uninstall")
    .alias("remove")
    .alias("rm")
    .description("Uninstall a plugin")
    .argument("<name>", "plugin name")
    .action((name: string) => uninstallCmd(name));

  plugin
    .command("list")
    .alias("ls")
    .description("List loaded plugins and what they contribute")
    .action(() => listCmd());

  plugin
    .command("enable")
    .description("Re-enable a disabled plugin")
    .argument("<name>", "plugin name")
    .action((name: string) => toggleCmd(name, "enable"));

  plugin
    .command("disable")
    .description("Disable a plugin without uninstalling it")
    .argument("<name>", "plugin name")
    .action((name: string) => toggleCmd(name, "disable"));

  const marketplace = new Command("marketplace")
    .alias("market")
    .description("Manage plugin marketplaces (catalogs)");

  marketplace
    .command("add")
    .description("Register a marketplace from a path, github repo, or git url")
    .argument("<nameOrSource>", "marketplace name (with <source>) or the source itself")
    .argument("[source]", "marketplace source when a name is given")
    .action((nameOrSource: string, source: string | undefined) =>
      marketplaceAdd(nameOrSource, source),
    );

  marketplace
    .command("list")
    .alias("ls")
    .description("List registered marketplaces")
    .action(() => marketplaceList());

  marketplace
    .command("remove")
    .alias("rm")
    .description("Remove a registered marketplace")
    .argument("<name>", "marketplace name")
    .action((name: string) => marketplaceRemove(name));

  marketplace.action(() => marketplace.help());
  plugin.addCommand(marketplace);

  // Bare `nova plugin` prints help rather than doing nothing.
  plugin.action(() => plugin.help());
  return plugin;
}
