import { dim, green, red, yellow } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/mcp";

/**
 * Show the status of configured MCP servers: connection state, transport, and
 * the tools each exposed. Pass `tools` to also list every bridged tool name.
 */
export function handleMcp(ctx: CliContext, args: string): void {
  if (!ctx.settings.mcp.enabled) {
    ctx.screen.card(dim("MCP is disabled (settings.mcp.enabled = false)."), { title: TITLE });
    return;
  }
  const mcp = ctx.mcp;
  if (!mcp || mcp.serverCount === 0) {
    ctx.screen.card(
      dim("no MCP servers configured. Add them under `mcp.servers` in nova.config.json."),
      { title: TITLE },
    );
    return;
  }

  const showTools = args.trim() === "tools";
  const status = [...mcp.status()].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.min(20, Math.max(...status.map((s) => s.name.length)));

  const lines: string[] = [];
  for (const s of status) {
    const badge =
      s.state === "connected"
        ? green("● connected")
        : s.state === "failed"
          ? red("● failed")
          : yellow("● disabled");
    const name = s.name.padEnd(nameWidth, " ");
    const meta = s.state === "connected" ? dim(`${s.transport} · ${s.toolCount} tool(s)`) : dim(s.transport);
    lines.push(`  ${name}  ${badge}  ${meta}`);
    if (s.error) lines.push(`  ${" ".repeat(nameWidth)}  ${dim(s.error)}`);
    if (showTools && s.toolNames.length > 0) {
      for (const t of s.toolNames) lines.push(`  ${" ".repeat(nameWidth)}    ${dim(t)}`);
    }
  }
  lines.push("");
  lines.push(
    dim(`${mcp.connectedCount}/${mcp.serverCount} connected · ${mcp.handlers().length} tool(s) bridged`),
  );
  if (!showTools) lines.push(dim("run `/mcp tools` to list bridged tool names"));

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
