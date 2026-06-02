import { dim, green, red, yellow } from "../colors.js";
import type { CliContext } from "../context.js";

const TITLE = "/lsp";

/**
 * Show the configured language servers: whether each binary is on PATH and
 * whether a server has been started this session. Servers start lazily on the
 * first `lsp` tool call, so "installed but idle" is the normal pre-use state.
 */
export function handleLsp(ctx: CliContext): void {
  if (!ctx.settings.lsp.enabled || !ctx.lspManager) {
    ctx.screen.card(dim("LSP is disabled (settings.lsp.enabled = false)."), { title: TITLE });
    return;
  }

  const status = [...ctx.lspManager.status()].sort((a, b) =>
    a.languageId.localeCompare(b.languageId),
  );
  if (status.length === 0) {
    ctx.screen.card(dim("no language servers configured."), { title: TITLE });
    return;
  }

  const idWidth = Math.min(16, Math.max(...status.map((s) => s.languageId.length)));

  const lines: string[] = [];
  for (const s of status) {
    const badge = s.running
      ? green("● running")
      : s.available
        ? yellow("○ installed")
        : red("● not installed");
    const id = s.languageId.padEnd(idWidth, " ");
    const meta = dim(`${s.command} · ${s.extensions.join(", ")}`);
    lines.push(`  ${id}  ${badge}  ${meta}`);
  }

  const running = status.filter((s) => s.running).length;
  const installed = status.filter((s) => s.available).length;
  lines.push("");
  lines.push(
    dim(`${installed}/${status.length} installed · ${running} running`),
  );
  if (installed < status.length) {
    lines.push(dim("missing servers must be installed on PATH (Nova does not install them)"));
  }

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}
