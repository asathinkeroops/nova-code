import { stat } from "node:fs/promises";
import type { SlashOutcome } from "@nova/external";
import { dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { NOVA_GUIDE_AGENT } from "../guide/agent.js";
import { ensureFresh, resolveGuideSourceDir } from "../guide/provisioner.js";

const TITLE = "/nova-code-guide";

/**
 * `/nova-code-guide <question>` — ask the read-only Nova Code Guide about Nova
 * itself. In "remote" mode it refreshes the local Nova source checkout (shallow
 * clone/pull); in "local" mode it reads a local dir directly (no network) — the
 * dev-friendly path when working on Nova itself. Either way it returns a prompt
 * directing the main agent to spawn the `nova-code-guide` sub-agent, which
 * answers from that source. The sub-agent's guidance is scoped to the source
 * dir, so the question is all the main agent needs to relay.
 */
export async function handleNovaCodeGuide(ctx: CliContext, args: string): Promise<SlashOutcome> {
  if (!ctx.settings.subagent.enabled) {
    return {
      kind: "error",
      message: "sub-agents are disabled in settings; /nova-code-guide needs them.",
    };
  }
  if (!ctx.settings.guide.enabled) {
    return { kind: "error", message: "Nova Code Guide is disabled (settings.guide.enabled)." };
  }
  const question = args.trim();
  if (!question) {
    return { kind: "error", message: "usage: /nova-code-guide <question about Nova>" };
  }

  const { guide } = ctx.settings;
  if (guide.source === "local") {
    // Local mode: no clone/fetch — just confirm the source dir exists so the
    // sub-agent doesn't spin up against a missing directory.
    const dir = resolveGuideSourceDir(guide, ctx.workspace);
    const isDir = await stat(dir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!isDir) {
      return {
        kind: "error",
        message:
          `local Nova source not found at ${dir} ` +
          `(set settings.guide.localPath, or switch settings.guide.source to "remote").`,
      };
    }
    ctx.screen.card(dim(`Using local Nova source at ${dir}.`), { title: TITLE });
  } else {
    ctx.screen.card(dim("Fetching the latest Nova source…"), { title: TITLE });
    let result;
    try {
      result = await ensureFresh({
        repoUrl: guide.repoUrl,
        ref: guide.ref,
        cacheDir: guide.cacheDir,
        maxAgeMs: guide.refreshIntervalHours * 3_600_000,
        logger: ctx.logger,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "error", message: `could not prepare the Nova source: ${msg}` };
    }
    if (result.offline) {
      ctx.screen.card(dim(`Offline — answering from the cached checkout at ${result.dir}.`), {
        title: TITLE,
      });
    }
  }

  const text =
    `Use createSubAgent with type "${NOVA_GUIDE_AGENT}" to answer the question below about ` +
    `Nova from its source, then relay its answer back to me as-is. The sub-agent already knows ` +
    `where the Nova source is checked out; just pass it the question, self-contained. Do not add ` +
    `source code, file paths, or line numbers of your own when relaying.\n\n` +
    `Question:\n${question}`;
  return { kind: "prompt", text };
}
