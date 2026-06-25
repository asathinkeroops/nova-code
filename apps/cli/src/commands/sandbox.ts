import { dim, green, red } from "../colors.js";
import { stopSpinner, type CliContext } from "../context.js";

const TITLE = "/sandbox";

const ON_WORDS = new Set(["on", "enable", "enabled", "true", "1"]);
const OFF_WORDS = new Set(["off", "disable", "disabled", "false", "0"]);

/**
 * Toggle the OS command sandbox for the current session. `/sandbox` with no arg
 * reports the current state; `/sandbox on|off` flips it via `ctx.setSandbox`,
 * which rebuilds the control and reassigns `ctx.sandbox`. The change is
 * session-only (not written to nova.config.json) and takes effect on the next
 * subprocess tool call.
 */
export async function handleSandbox(ctx: CliContext, arg: string): Promise<void> {
  const a = arg.trim().toLowerCase();

  if (a === "" || a === "status") {
    reportStatus(ctx);
    return;
  }

  let enable: boolean;
  if (ON_WORDS.has(a)) enable = true;
  else if (OFF_WORDS.has(a)) enable = false;
  else {
    ctx.screen.card(`unknown argument "${arg.trim()}" — use ${TITLE} on|off`, {
      kind: "error",
      title: TITLE,
    });
    return;
  }

  const spinner = ctx.screen.startSpinner(enable ? "Enabling sandbox" : "Disabling sandbox");
  ctx.spinner = spinner;
  try {
    const control = await ctx.setSandbox(enable);
    stopSpinner(ctx);
    if (!enable) {
      ctx.screen.card(`${dim("sandbox")} ${red("off")} ${dim("(this session)")}`, {
        kind: "info",
        title: TITLE,
      });
      return;
    }
    if (control.active) {
      ctx.screen.card(
        `${dim("sandbox")} ${green("on")} ${dim(
          "— subprocess writes confined to the workspace (this session)",
        )}`,
        { kind: "info", title: TITLE },
      );
    } else {
      // createSandbox never throws — it degrades to an inactive control on an
      // unsupported platform / missing host deps. Surface why so the user isn't
      // left thinking it's enforcing when it isn't.
      ctx.screen.card(
        `sandbox requested but inactive: ${control.reason ?? "unknown reason"}`,
        { kind: "warn", title: TITLE },
      );
    }
  } catch (err) {
    stopSpinner(ctx);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { kind: "error", title: `${TITLE} failed` });
  }
}

function reportStatus(ctx: CliContext): void {
  const active = ctx.sandbox?.active ?? false;
  if (active) {
    ctx.screen.card(
      `${dim("sandbox:")} ${green("active")} ${dim(
        "— subprocess writes confined to the workspace",
      )}\n${dim("disable with")} ${TITLE} off`,
      { title: TITLE },
    );
    return;
  }
  const reason = ctx.sandbox?.reason;
  const why = reason ? dim(` (${reason})`) : "";
  ctx.screen.card(
    `${dim("sandbox:")} ${red("inactive")}${why}\n${dim("enable with")} ${TITLE} on`,
    { title: TITLE },
  );
}
