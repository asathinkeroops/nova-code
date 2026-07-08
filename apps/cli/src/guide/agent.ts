import type { AgentDefinition } from "@nova/subagent";

/** The `type` value used to spawn the guide sub-agent, and its slash-command name. */
export const NOVA_GUIDE_AGENT = "nova-code-guide";

/** Where the guide's source comes from — shapes one line of its guidance. */
export interface GuideAgentOptions {
  /** True when reading a local dir (source: "local") rather than a remote clone. */
  local?: boolean;
}

/**
 * Build the read-only sub-agent definition that answers questions about Nova
 * itself. `checkoutDir` is the absolute path of the Nova source the guide reads
 * — a remote clone (source: "remote") or a local dir (source: "local"). It is
 * baked into the guidance so the agent always knows where the ground-truth
 * source lives. The definition is registered at startup rather than shipped in
 * BUILTIN_AGENTS because the path is resolved per-host.
 *
 * Read-only + a `read/grep/glob` allow-list keeps it to agentic retrieval over
 * the checkout: no writes, no bash, no network, no LSP (the LSP manager is
 * rooted at the user's workspace, not this checkout).
 */
export function buildGuideAgentDefinition(
  checkoutDir: string,
  opts: GuideAgentOptions = {},
): AgentDefinition {
  // In remote mode the user's cwd is a different, unrelated project, so steer
  // the agent firmly at the checkout. In local mode the checkout usually *is*
  // the workspace, so that warning would be wrong — just point at the dir.
  const scopeLine = opts.local
    ? `- That directory is the Nova source and your source of truth. Target your read/grep/glob calls at paths under ${checkoutDir}.`
    : `- That checkout is the ONLY source of truth. Every read/grep/glob you run MUST target a path under ${checkoutDir} (pass it as the path or search root). Do NOT read the user's current working directory — it is unrelated to Nova.`;
  return {
    name: NOVA_GUIDE_AGENT,
    description:
      "Answers questions about Nova ITSELF — how Nova works, its architecture, features, tools, " +
      "slash commands, sub-agents, permissions, sandbox, memory, context/compaction, and other " +
      "internals — by reading the actual Nova source. USE THIS whenever the user asks how Nova " +
      "does something, what Nova supports, or why Nova behaves a certain way, instead of answering " +
      "from memory. Read-only; explains in plain language (no code or file paths in its answer).",
    roleLine:
      "the Nova Code Guide — a read-only expert on the Nova codebase who answers questions about " +
      "how Nova works, grounded in its actual source",
    guidance: [
      "- You are READ-ONLY: you have no write/edit/bash tools and cannot modify files or run commands.",
      `- The Nova source is at: ${checkoutDir}`,
      scopeLine,
      "- Ground your understanding in the actual source: read and grep it before answering. If the source does not cover something, say so — never guess or rely on prior knowledge of Nova.",
      `- Orient yourself first: read the top-level README / CLAUDE.md and skim the package layout under ${checkoutDir}, then grep for the specific symbols the question is about before answering.`,
      '- CRITICAL — your final answer must contain NO source code, no code snippets, no file paths, and no line numbers. Read the code to understand it, then explain in plain prose: describe the behavior, the concepts, and the design. Refer to parts of Nova by name (e.g. "the model loop", "the permission engine", "the sub-agent registry"), never by file location.',
      "- Answer the question directly and concisely. You are a guide, not an implementer — do not propose or write code changes.",
    ].join("\n"),
    readOnly: true,
    allowTools: ["read", "grep", "glob"],
    source: "builtin",
  };
}
