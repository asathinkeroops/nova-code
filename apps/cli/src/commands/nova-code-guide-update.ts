import type { SlashOutcome } from "@nova/base";
import { dim } from "../colors.js";
import { stopSpinner, type CliContext } from "../context.js";
import { ensureFresh, resolveGuideSourceDir } from "../guide/provisioner.js";
import { FETCH_SPINNER, PROVISION_HINT } from "./nova-code-guide.js";

const TITLE = "/nova-code-guide-update";

/**
 * `/nova-code-guide-update` — manually (re)fetch the Nova source the guide reads.
 *
 * In "remote" mode this shallow-clones (first run) or shallow-fetches + hard-resets
 * (subsequent runs) the checkout, **ignoring the TTL** so it always hits the network
 * — the escape hatch when the background warm was offline and the user wants to try
 * again on demand. A failed *update* keeps the cached checkout (reported as offline);
 * a failed *initial clone* has nothing to fall back to and surfaces an error with
 * {@link PROVISION_HINT} spelling out how to recover.
 *
 * In "local" mode there is nothing to fetch — the guide reads a local dir directly —
 * so this just reports which dir that is.
 */
export async function handleNovaCodeGuideUpdate(ctx: CliContext): Promise<SlashOutcome> {
  if (!ctx.settings.subagent.enabled) {
    return {
      kind: "error",
      message: "sub-agents are disabled in settings; /nova-code-guide needs them.",
    };
  }
  if (!ctx.settings.guide.enabled) {
    return { kind: "error", message: "Nova Code Guide is disabled (settings.guide.enabled)." };
  }

  const { guide } = ctx.settings;
  if (guide.source === "local") {
    const dir = resolveGuideSourceDir(guide, ctx.workspace);
    ctx.screen.card(dim(`Local mode — the guide reads ${dir} directly; nothing to fetch.`), {
      title: TITLE,
    });
    return { kind: "handled" };
  }

  // Live spinner while git works — the fetch/clone can take several seconds, and
  // without it the TUI looks frozen. Torn down on every exit path below.
  ctx.spinner = ctx.screen.startSpinner(FETCH_SPINNER);
  let result;
  try {
    result = await ensureFresh({
      repoUrl: guide.repoUrl,
      ref: guide.ref,
      cacheDir: guide.cacheDir,
      // No maxAgeMs: a manual update always hits the network, bypassing the TTL.
      logger: ctx.logger,
    });
  } catch (err) {
    stopSpinner(ctx);
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `could not update the Nova source: ${msg}\n${PROVISION_HINT}` };
  }
  stopSpinner(ctx);

  if (result.offline) {
    ctx.screen.card(
      dim(`Offline — kept the cached checkout at ${result.dir} (could not reach origin).`),
      { title: TITLE },
    );
  } else {
    ctx.screen.card(dim(`Updated — Nova source is current at ${result.dir}.`), { title: TITLE });
  }
  return { kind: "handled" };
}
