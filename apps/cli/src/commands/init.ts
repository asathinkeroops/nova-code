import type { SlashOutcome } from "@nova/runtime";

/**
 * `/init` — bootstrap (or refresh) the project memory file. Returns a prompt
 * that directs the main agent to explore the repository with its own tools and
 * write a concise `NOVA.md` describing how to work in this codebase.
 *
 * If a memory file already exists (NOVA.md / CLAUDE.md / AGENTS.md), the agent
 * is told to read and improve it in place rather than overwrite from scratch.
 *
 * Pure: depends only on the args string, so it lives outside CliContext.
 */
export function handleInit(args: string): SlashOutcome {
  const focus = args.trim();
  const focusLine = focus
    ? `\n\nThe user asked you to pay particular attention to: ${focus}`
    : "";

  const text =
    "Initialize or refresh this project's memory file so a coding agent can be " +
    "productive here immediately. Work in these steps:\n\n" +
    "1. Explore the repository with your tools. Read the root manifest(s) " +
    "(package.json, pyproject.toml, Cargo.toml, go.mod, etc.), the directory " +
    "layout, build/test/lint scripts, and any existing config to understand " +
    "what this project is and how it is built.\n" +
    "2. Check whether a memory file already exists at the repo root — look for " +
    "NOVA.md, then CLAUDE.md, then AGENTS.md. If one exists, READ it and IMPROVE " +
    "it in place (keep what is still accurate, fix what is stale, fill gaps); do " +
    "NOT discard hand-written guidance. If none exists, create NOVA.md.\n" +
    "3. Write the file with the Write tool. Keep it concise and high-signal — " +
    "this is instructions for a coding agent, not a README for humans. Cover: " +
    "what the project is, the commands to build/test/lint/run, the high-level " +
    "architecture and any non-obvious invariants or conventions a newcomer would " +
    "trip over. Prefer specifics drawn from the actual code over generic advice; " +
    "omit boilerplate the agent can read from the code itself.\n" +
    "4. When done, briefly tell me which file you wrote and what it covers." +
    focusLine;

  return { kind: "prompt", text };
}
