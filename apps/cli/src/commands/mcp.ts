import type { McpManager, McpServerState, McpServerStatus } from "@nova/mcp";
import { ACCENT_HEX, bold, cyan, dim, green, yellow, magenta, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import {
  FileOAuthStore,
  openBrowser,
  startCallbackServer,
  type CallbackServer,
} from "../mcp-oauth.js";
import { pickerArrow } from "../ui/picker.js";
import { overlayNotice } from "./overlay-notice.js";

const TITLE = "/mcp";

/** How long to wait for the browser redirect before giving up the loopback. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/**
 * The MCP control surface.
 *   /mcp        — interactive menu: pick a server, then an action
 *                 (Authenticate / Reconnect / Log out / View tools)
 *   /mcp tools  — non-interactive: list every bridged tool & prompt
 *
 * The bare form mirrors Claude Code's menu — authentication is an action inside
 * the menu, not a parameterized command. Falls back to a static status card when
 * there's no TTY (e.g. piped).
 */
export async function handleMcp(ctx: CliContext, args: string): Promise<void> {
  if (!ctx.settings.mcp.enabled) {
    await overlayNotice(ctx, TITLE, [dim(t.mcp.disabled)]);
    return;
  }
  const mcp = ctx.mcp;
  if (!mcp || mcp.serverCount === 0) {
    await overlayNotice(ctx, TITLE, [dim(t.mcp.noServers)]);
    return;
  }

  if (args.trim() === "tools") {
    renderStatusCard(ctx, mcp, true);
    return;
  }

  if (!process.stdout.isTTY) {
    renderStatusCard(ctx, mcp, false);
    return;
  }
  await runMenu(ctx, mcp);
}

// ===== Interactive menu =====

interface Action {
  key: "auth" | "reconnect" | "logout" | "tools" | "back";
  label: string;
}

/** Top level: a scrollable list of servers; selecting one opens its actions. */
async function runMenu(ctx: CliContext, mcp: McpManager): Promise<void> {
  for (;;) {
    const servers = [...mcp.status()].sort((a, b) => a.name.localeCompare(b.name));
    const pending = mcp.serversNeedingAuth().length;
    const pick = await ctx.screen.pickOne<McpServerStatus>({
      header:
        bold(t.mcp.serversHeader) +
        dim(t.mcp.connectedSummary(mcp.connectedCount, mcp.serverCount, pending)),
      footer: dim(t.mcp.footerSelectOpen),
      items: servers,
      render: (s, sel) => `${pickerArrow(sel)} ${rowLabel(s)}`,
      pageSize: 12,
      border: false,
      topRuleColor: ACCENT_HEX,
    });
    if (!pick) return;
    await serverActions(ctx, mcp, pick.name);
  }
}

/** Second level: the actions available for one server, gated on its state. */
async function serverActions(ctx: CliContext, mcp: McpManager, name: string): Promise<void> {
  const s = mcp.status().find((x) => x.name === name);
  if (!s) return;
  const oauth = mcp.isOAuthCapable(name);

  const actions: Action[] = [];
  if (s.state === "connected") {
    actions.push({ key: "tools", label: t.mcp.viewToolsLabel });
    if (oauth) actions.push({ key: "logout", label: t.mcp.logOut });
    actions.push({ key: "reconnect", label: t.mcp.reconnect });
  } else if (s.state === "needs-auth") {
    actions.push({ key: "auth", label: t.mcp.authenticate });
    actions.push({ key: "reconnect", label: t.mcp.reconnect });
  } else {
    if (oauth) actions.push({ key: "auth", label: t.mcp.authenticate });
    actions.push({ key: "reconnect", label: t.mcp.reconnect });
  }
  actions.push({ key: "back", label: t.mcp.back });

  const pick = await ctx.screen.pickOne<Action>({
    header: `${cyan(name)}  ${stateBadge(s.state)}` + (s.error ? `  ${dim(s.error)}` : ""),
    footer: dim(t.mcp.footerSelectRun),
    items: actions,
    render: (a, sel) => `${pickerArrow(sel)} ${a.label}`,
    border: false,
    topRuleColor: ACCENT_HEX,
  });
  if (!pick || pick.key === "back") return;

  switch (pick.key) {
    case "auth":
      await authenticateServer(ctx, name);
      break;
    case "reconnect":
      await reconnectServer(ctx, mcp, name);
      break;
    case "logout":
      await logoutServer(ctx, mcp, name);
      break;
    case "tools":
      await viewTools(ctx, mcp, name);
      break;
  }
}

// ===== Actions =====

/** Drive the interactive OAuth grant for `name`, registering what it bridges. */
async function authenticateServer(ctx: CliContext, name: string): Promise<void> {
  const mcp = ctx.mcp!;
  if (!mcp.isOAuthCapable(name)) {
    ctx.screen.card(
      `${red(t.mcp.cannotAuthorize)} ${dim(t.mcp.notRemoteOAuth(name))}`,
      { title: TITLE },
    );
    return;
  }

  let server: CallbackServer;
  try {
    server = await startCallbackServer(ctx.settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { callbackHost, callbackPort } = ctx.settings.mcp.oauth;
    ctx.screen.card(
      `${red(t.mcp.callbackServerFailed)}${t.mcp.callbackServerOn(callbackHost, callbackPort)}` +
        dim(`${msg}\n${t.mcp.freePort}`),
      { title: TITLE },
    );
    return;
  }

  try {
    let result = await mcp.authorize(name);

    if (result.status === "redirect") {
      const url = result.authorizationUrl.toString();
      openBrowser(url);

      const waited = await waitForBrowserAuth(ctx, server, name, url);
      if (waited.kind === "cancelled") return; // esc — leave the feed quiet
      if (waited.kind === "error") {
        ctx.screen.card(`${red(t.mcp.authDidNotComplete)} ${dim(waited.message)}`, {
          title: TITLE,
        });
        return;
      }
      if (result.expectedState && waited.state !== result.expectedState) {
        ctx.screen.card(red(t.mcp.authRejectedCsrf), {
          title: TITLE,
        });
        return;
      }
      result = await result.complete(waited.code);
    }

    if (result.status === "connected") {
      const n = syncRegistries(ctx);
      ctx.screen.card(`${green(t.mcp.authorized)} ${cyan(name)}${t.mcp.toolsNowAvailable(n)}`, {
        title: TITLE,
      });
    } else if (result.status === "error" || result.status === "unsupported") {
      ctx.screen.card(`${red(t.mcp.authFailed)} ${dim(result.error)}`, { title: TITLE });
    }
  } finally {
    server.close();
  }
}

/** Re-attempt a server's connection and register anything it newly bridges. */
async function reconnectServer(ctx: CliContext, mcp: McpManager, name: string): Promise<void> {
  const state = await mcp.reconnect(name);
  if (state === "connected") {
    const n = syncRegistries(ctx);
    ctx.screen.card(`${green(t.mcp.reconnected)} ${cyan(name)}${t.mcp.toolsAvailable(n)}`, {
      title: TITLE,
    });
  } else if (state === "needs-auth") {
    ctx.screen.card(
      `${magenta(t.mcp.needsAuthWord)}${t.mcp.reconnectChoose}${bold(t.mcp.authenticate)}${t.mcp.reconnectFor}${cyan(name)}${t.mcp.reconnectDot}`,
      {
        title: TITLE,
      },
    );
  } else {
    const err = mcp.status().find((s) => s.name === name)?.error;
    ctx.screen.card(`${red(t.mcp.stillFailed)} ${dim(err ?? t.mcp.couldNotConnect)}`, {
      title: TITLE,
    });
  }
}

/** Clear a server's stored OAuth tokens, drop its live tools, mark needs-auth. */
async function logoutServer(ctx: CliContext, mcp: McpManager, name: string): Promise<void> {
  const { toolNames, promptNames } = await mcp.disconnect(name);
  for (const t of toolNames) ctx.tools.unregister(t);
  for (const p of promptNames) ctx.registry.remove(p);
  try {
    await new FileOAuthStore(name).clear();
  } catch {
    // token file may not exist; clearing is best-effort
  }
  ctx.screen.card(
    `${green(t.mcp.loggedOut)} ${cyan(name)}${t.mcp.clearedTokens(toolNames.length)}`,
    { title: TITLE },
  );
}

/** Page through one server's bridged tool and prompt names. */
async function viewTools(ctx: CliContext, mcp: McpManager, name: string): Promise<void> {
  const s = mcp.status().find((x) => x.name === name);
  const lines: string[] = [];
  if (s) {
    for (const t of s.toolNames) lines.push(dim(t));
    for (const p of s.promptNames) lines.push(dim(`/${p}`));
  }
  await ctx.screen.viewer({
    header: `${cyan(name)}${t.mcp.toolCountSuffix(s?.toolNames.length ?? 0)}`,
    lines: lines.length > 0 ? lines : [dim(t.mcp.noToolsBridged)],
    footer: dim(t.mcp.footerEscClose),
    border: false,
    topRuleColor: ACCENT_HEX,
  });
}

// ===== Shared helpers =====

/**
 * Register any connected MCP surface not already present in the live registries.
 * Idempotent — safe to call after every connect/auth/reconnect. Returns the
 * number of newly-registered tools.
 */
function syncRegistries(ctx: CliContext): number {
  const mcp = ctx.mcp!;
  let added = 0;
  for (const h of [...mcp.handlers(), ...mcp.resourceTools()]) {
    if (!ctx.tools.get(h.definition.name)) {
      ctx.tools.register(h);
      added++;
    }
  }
  for (const p of mcp.promptCommands()) ctx.registry.register(p);
  return added;
}

function stateBadge(state: McpServerState): string {
  return state === "connected"
    ? green(t.mcp.badgeConnected)
    : state === "needs-auth"
      ? magenta(t.mcp.badgeNeedsAuth)
      : state === "failed"
        ? red(t.mcp.badgeFailed)
        : yellow(t.mcp.badgeDisabled);
}

function rowLabel(s: McpServerStatus): string {
  const counts =
    s.state === "connected"
      ? dim(t.mcp.rowCountsConnected(s.transport, s.toolCount, s.promptCount, s.resourceCount))
      : dim(` ${s.transport}`);
  return `${s.name.padEnd(14)} ${stateBadge(s.state)}${counts}`;
}

/** Static, non-interactive status card (used by `/mcp tools` and non-TTY). */
function renderStatusCard(ctx: CliContext, mcp: McpManager, showTools: boolean): void {
  const status = [...mcp.status()].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.min(20, Math.max(...status.map((s) => s.name.length)));

  const lines: string[] = [];
  for (const s of status) {
    const name = s.name.padEnd(nameWidth, " ");
    const meta =
      s.state === "connected"
        ? dim(t.mcp.cardMetaConnected(s.transport, s.toolCount, s.promptCount, s.resourceCount))
        : dim(s.transport);
    lines.push(`  ${name}  ${stateBadge(s.state)}  ${meta}`);
    if (s.error) lines.push(`  ${" ".repeat(nameWidth)}  ${dim(s.error)}`);
    if (showTools) {
      for (const t of s.toolNames) lines.push(`  ${" ".repeat(nameWidth)}    ${dim(t)}`);
      for (const p of s.promptNames) lines.push(`  ${" ".repeat(nameWidth)}    ${dim(`/${p}`)}`);
    }
  }
  lines.push("");
  const promptTotal = mcp.promptCommands().length;
  const resourceServers = status.filter((s) => s.resourceCount > 0).length;
  lines.push(
    dim(
      t.mcp.summaryLine(
        mcp.connectedCount,
        mcp.serverCount,
        mcp.handlers().length,
        promptTotal,
        resourceServers,
      ),
    ),
  );
  const pending = mcp.serversNeedingAuth();
  if (pending.length > 0) {
    lines.push(dim(t.mcp.pendingHint(pending.join(", "))));
  }
  if (!showTools) lines.push(dim(t.mcp.toolsHint));

  ctx.screen.card(lines.join("\n"), { title: TITLE });
}

type WaitResult =
  | { kind: "code"; code: string; state?: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

/**
 * Show a cancellable "waiting for the browser" modal while the loopback listens
 * for the OAuth redirect. The modal closes itself when the redirect lands (via
 * the abort signal) or when the user presses esc to give up.
 *
 * This is what keeps the REPL from silently hanging: the earlier implementation
 * awaited the 5-minute loopback with no visible, cancellable UI, so the picker
 * unmounted and the input box looked idle while the command was still running —
 * any command typed then just queued behind it. Here the wait is a foreground
 * modal the user can always escape.
 */
async function waitForBrowserAuth(
  ctx: CliContext,
  server: CallbackServer,
  name: string,
  url: string,
): Promise<WaitResult> {
  const controller = new AbortController();
  // A holder (not a bare `let`) so the reads below keep the union type — TS
  // can't see the callback assignments and would narrow a local to `never`.
  const box: { settled: { code: string; state?: string } | { error: string } | null } = {
    settled: null,
  };
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AUTH_TIMEOUT_MS);
  void server.waitForCode
    .then(
      (r) => {
        box.settled = r;
      },
      (e: unknown) => {
        box.settled = { error: e instanceof Error ? e.message : String(e) };
      },
    )
    .finally(() => {
      clearTimeout(timer);
      controller.abort();
    });

  await ctx.screen.viewer(
    {
      header: `${bold(t.mcp.waitingForAuth)} — ${cyan(name)}`,
      lines: [
        dim(t.mcp.approveInBrowser),
        "",
        dim(t.mcp.ifNotOpened),
        url,
        "",
        dim(t.mcp.pressEscCancel),
      ],
      border: false,
      topRuleColor: ACCENT_HEX,
    },
    { signal: controller.signal },
  );
  // Guarantee the backstop timer never outlives the modal (e.g. on esc-cancel,
  // where the loopback promise stays pending and its .finally never runs).
  clearTimeout(timer);

  const done = box.settled;
  if (done === null) {
    return timedOut
      ? { kind: "error", message: t.mcp.timedOut(Math.round(AUTH_TIMEOUT_MS / 1000)) }
      : { kind: "cancelled" };
  }
  if ("error" in done) return { kind: "error", message: done.error };
  return { kind: "code", code: done.code, state: done.state };
}
