import { saveSettings } from "@nova/runtime";
import { accent, dim, green, yellow } from "../colors.js";
import type { CliContext } from "../context.js";

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
  const [sub, name] = args.trim().split(/\s+/, 2);

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
