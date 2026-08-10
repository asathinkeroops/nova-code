import { accent, ACCENT_HEX, dim, green, yellow, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";

const TITLE = "/lsp";

/**
 * Show the configured language servers: whether each binary is on PATH and
 * whether a server has been started this session. Servers start lazily on the
 * first `lsp` tool call, so "installed but idle" is the normal pre-use state.
 */
export async function handleLsp(ctx: CliContext): Promise<void> {
  // Both status and empty states render in the same top-ruled overlay, so /lsp
  // always opens a 弹层 rather than dropping an inline card.
  const show = (lines: string[]): Promise<void> =>
    ctx.screen.viewer({
      lines,
      header: accent(TITLE),
      footer: dim(t.common.footerScrollClose),
      pageSize: 24,
      border: false,
      topRuleColor: ACCENT_HEX,
    });

  if (!ctx.settings.lsp.enabled || !ctx.lspManager) {
    await show([dim(t.lsp.disabled)]);
    return;
  }

  const status = [...ctx.lspManager.status()].sort((a, b) =>
    a.languageId.localeCompare(b.languageId),
  );
  if (status.length === 0) {
    await show([dim(t.lsp.noneConfigured)]);
    return;
  }

  const idWidth = Math.min(16, Math.max(...status.map((s) => s.languageId.length)));

  const lines: string[] = [];
  for (const s of status) {
    const badge = s.running
      ? green(t.lsp.running)
      : s.available
        ? yellow(t.lsp.installed)
        : red(t.lsp.notInstalled);
    const id = s.languageId.padEnd(idWidth, " ");
    const meta = dim(`${s.command} · ${s.extensions.join(", ")}`);
    lines.push(`  ${id}  ${badge}  ${meta}`);
  }

  const running = status.filter((s) => s.running).length;
  const installed = status.filter((s) => s.available).length;
  lines.push("");
  lines.push(
    dim(t.lsp.summary(installed, status.length, running)),
  );
  if (installed < status.length) {
    lines.push(dim(t.lsp.missingNote));
  }

  await show(lines);
}
