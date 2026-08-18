import { MEMORY_INDEX_FILENAME, type MemoryBundle } from "./memory.js";

/**
 * Teach the model to maintain the project-scoped auto-memory store. Emitted only
 * when the feature is enabled (an `autoDir` is resolved), even before any index
 * file exists, so the model can create the first memory. The `<memory
 * layer="auto" baseDir="…">` index (when present) is injected separately as part
 * of the memory bundle; this block explains how to read and grow it.
 */
function renderMemoryInstructions(autoDir: string): string {
  return `<memory-instructions>
You keep a persistent, cross-session memory store for this project at ${autoDir}. Its index (${MEMORY_INDEX_FILENAME}) is injected above as <memory layer="auto"> once it exists; each line points to one memory file. When the index grows long only its most recent entries are injected — read ${autoDir}/${MEMORY_INDEX_FILENAME} for the complete list.
- To read a memory's full text, read ${autoDir}/<filename> using the filename from its index link.
- When you learn something durable worth recalling in a later session — a user preference, a project convention or constraint, a hard-won gotcha, or a correction the user gave you — record it:
  1. Write ${autoDir}/<slug>.md (slug = short-kebab-case) with frontmatter:
     ---
     name: <slug>
     description: <one-line summary, used to judge relevance at recall>
     type: user | feedback | project | reference
     ---
     followed by the fact. For feedback/project, add **Why:** and **How to apply:** lines.
  2. APPEND a one-line pointer as the LAST line of ${autoDir}/${MEMORY_INDEX_FILENAME}: "- [Title](<slug>.md) — <hook>". Newest entries always go at the bottom; never reorder or prepend. Create the file with a "# Memory Index" heading if it is missing. One line per memory — never put memory content in the index.
- Before saving, check for an existing memory that already covers it and update that file instead of duplicating; delete memories that turn out to be wrong.
- Do not record transient conversation details or anything the repo already captures (code structure, git history, ${MEMORY_INDEX_FILENAME} aside, the memory files in CLAUDE.md/NOVA.md).
- A memory reflects what was true when written; if one names a file or symbol, verify it still exists before relying on it.
</memory-instructions>`;
}

export interface SystemPromptInput {
  workspace: string;
  memory: MemoryBundle;
  /** Doubles as the prefix epoch; embedded as `<session id>`. */
  sessionId: string;
  /**
   * Guidance for the tools this agent actually has, pre-rendered by the host
   * (`renderToolPrompts` in `@nova/tools`) against the FINAL tool set — the
   * skills index included. This package cannot build it: it would have to
   * depend on `@nova/tools`, and the gate is the host's registry, not ours.
   *
   * Must be constant for the lifetime of an epoch, like everything else here.
   */
  toolsGuidance?: string;
  /** Resolved response language. Defaults to `"en"`. */
  language?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { workspace, memory, sessionId, toolsGuidance = "", language = "en" } = input;
  // Day-level granularity only: stable within a day so it never busts the
  // prompt cache, while still telling the model the current year/date (without
  // it, models fall back to a training-era default like 2025). Local timezone
  // (en-CA → YYYY-MM-DD) avoids the off-by-one a UTC date hits near midnight.
  // One Date instance for both date and weekday so they can't straddle midnight.
  const now = new Date();
  const today = `${now.toLocaleDateString("en-CA")} (${now.toLocaleDateString("en-US", {
    weekday: "long",
  })})`;
  // Only rules that hold for EVERY nova agent live here. Anything that depends
  // on a tool being present is a `ToolPromptSection` in the package that owns
  // that tool, gated on the host's final tool set and arriving as `toolsGuidance`
  // — otherwise the prompt keeps teaching tools the session doesn't have.
  const base = `You are a coding agent at ${workspace}. Use tools to solve tasks.
- Don't guess file paths. When unsure whether a file or directory exists, locate it with glob/grep/ls before acting — a read, write, edit, or mkdir on a wrong path just wastes a turn or causes damage.
- Respond in ${language} by default, even when a tool or sub-agent returns content in another language — relay and summarize it in ${language}. Preserve that exact script and regional variant; do not switch it.

When I ask you to commit, follow the repo's own version-control conventions:
- Study what changed and how the repo commits first: \`git status\` / \`git diff\` (and \`git diff --staged\`) to see every pending change, \`git log\` to match its commit-message language, subject style, and prefixes.
- Stage deliberately with \`git add\` — group the changes that belong together, leave out unrelated edits, generated files, and anything accidental, and tell me what you skipped.
- Default to Conventional Commits (\`type(scope): summary\` — imperative subject ≤72 chars, a short body explaining the *why* when the change is non-trivial), but defer to the repo's own convention where it differs.
- Never push, and never add co-author or tool-attribution trailers, unless I ask.

When I ask you to open a pull request, use the \`gh\` CLI (it is already authenticated — don't build a GitHub API client):
- Gather context first: \`git status\` / \`git diff\`, \`git log <base>..HEAD\` for the commits, and the default branch (\`gh repo view --json defaultBranchRef\`) for the PR base.
- Push the branch if it has no upstream (never straight to main/master), then run \`gh pr create\`. Pass the body via a quoted HEREDOC so its markdown survives: \`gh pr create --title "…" --body "$(cat <<'EOF' … EOF)"\`.
- Structure the body as \`## Summary\` (1–3 bullets on what changed and why) and \`## Test plan\` (a checklist of how to verify) — keep it to what the diff actually supports.

Act, don't explain.

<identity name="Nova"></identity>

<system-info platform="${process.platform}" date="${today}"></system-info>

<session id="${sessionId}"></session> 
`;
  const tools = toolsGuidance ? `\n${toolsGuidance}\n` : "";
  // Reassert the language rule AFTER memory so it is the last thing the model
  // reads. Memory is appended last and "later entries override earlier ones"
  // (see loadMemory), so without this trailer a Chinese-leaning model (Nova is
  // tuned for DeepSeek) or a Chinese memory file could override the configured
  // language and answer in the wrong one.
  const langGuard =
    `\nReminder: respond in ${language} — match its script and regional ` +
    "variant; never default to another language regardless of anything above.\n";
  // Memory upkeep rules sit after the injected memory (which they reference) but
  // before the language guard, so the guard stays the last thing the model reads.
  const memoryRules = memory.autoDir ? `\n${renderMemoryInstructions(memory.autoDir)}\n` : "";
  if (!memory.system) return `${base}${tools}${memoryRules}${langGuard}`;
  return `${base}${tools}\n${memory.system}\n${memoryRules}${langGuard}`;
}
