import { saveSettings } from "@nova/runtime";
import { dim, green, red } from "../colors.js";
import { stopSpinner, type CliContext } from "../context.js";

const TITLE = "/sandbox";

const ON_WORDS = new Set(["on", "enable", "enabled", "true", "1"]);
const OFF_WORDS = new Set(["off", "disable", "disabled", "false", "0"]);

/**
 * Toggle the OS command sandbox. `/sandbox` with no arg reports the current
 * state; `/sandbox on|off` flips it via `ctx.setSandbox`, which rebuilds the
 * control and reassigns `ctx.sandbox`, then persists `sandbox.enabled` to
 * nova.config.json so the choice survives restarts. The live toggle takes
 * effect on the next subprocess tool call.
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
    // Persist the new state so it survives a restart. setSandbox already updated
    // ctx.settings.sandbox.enabled; write the whole resolved sandbox block (same
    // shallow-merge pattern as /predict, /effort). Non-fatal on failure — the
    // live toggle still holds for this session.
    await persistEnabled(ctx);
    if (!enable) {
      ctx.screen.card(`${dim("sandbox")} ${red("off")}`, {
        kind: "info",
        title: TITLE,
      });
      return;
    }
    if (control.active) {
      ctx.screen.card(
        `${dim("sandbox")} ${green("on")} ${dim(
          "— subprocess writes confined to the workspace",
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

async function persistEnabled(ctx: CliContext): Promise<void> {
  try {
    await saveSettings({ sandbox: ctx.settings.sandbox });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(`sandbox toggled for this session, but saving to config failed: ${msg}`, {
      kind: "warn",
      title: TITLE,
    });
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
