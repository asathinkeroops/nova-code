import { dim, green, yellow } from "../colors.js";
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
 * List the plugins loaded into this session and what each contributed. Managing
 * plugins (install/uninstall, enable/disable, marketplaces) materializes files
 * and edits settings, so it lives in the `nova plugin` CLI (mirroring `nova mcp`
 * / `claude plugin`), not here — run `nova plugin …` from your shell.
 */
export async function handlePlugin(ctx: CliContext): Promise<void> {
  if (!ctx.settings.plugins.enabled) {
    ctx.screen.card(dim("plugins are disabled (settings.plugins.enabled = false)."), {
      title: TITLE,
    });
    return;
  }
  if (ctx.plugins.length === 0) {
    ctx.screen.card(
      dim("no plugins loaded. install one from your shell with `nova plugin install <src>`."),
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
      p.binDirs.length > 0 ? "bin" : "",
    ].filter(Boolean);
    const version = p.manifest.version ? dim(` v${p.manifest.version}`) : "";
    lines.push(`  ${green("●")} ${p.manifest.name}${version}  ${dim(`[${p.source}]`)}`);
    if (parts.length > 0) lines.push(`    ${dim(parts.join(" · "))}`);
    else lines.push(`    ${dim("(no contributions)")}`);
    if (p.ignored.length > 0) {
      lines.push(`    ${yellow(`ignored: ${p.ignored.map((i) => i.kind).join(", ")}`)}`);
    }
  }
  lines.push("");
  lines.push(dim(`${ctx.plugins.length} plugin(s) loaded · manage with \`nova plugin …\``));

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
