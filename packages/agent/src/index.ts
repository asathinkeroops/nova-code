/**
 * The package's public API — and nothing else.
 *
 * Two rules keep this list short. **Export only what a consumer imports**: an
 * export nothing imports is dead weight exactly as a declared dependency
 * nothing imports is, and it invites reaching past the entry points into the
 * implementation. Everything below has a live call site outside this package;
 * add a symbol when something needs it, not in anticipation. **One symbol, one
 * path**: the agent abstraction and its hooks belong to `@nova/core` and are
 * imported from there, not forwarded through here — a re-export just makes the
 * same type reachable two ways and hides which package owns it.
 *
 * The port implementations (`ports.ts`), the sub-agent tool, and the summarizer
 * are deliberately absent: `assembleSession` / `assembleAgent` / `buildCompactor`
 * are how a host reaches them.
 */

// ── assembly: what a host calls to build an agent ─────────────────────────
export { assembleSession } from "./session.js";
export { assembleAgent } from "./assemble.js";

// ── system prompt and memory ──────────────────────────────────────────────
export { buildSystemPrompt, type SystemPromptInput } from "./system-prompt.js";
export { loadMemory, type MemoryBundle } from "./memory.js";

// ── history persistence ───────────────────────────────────────────────────
export { loadMessages, emptyCursor, type PersistCursor } from "./persistence.js";

// ── compaction: the boundary, the threshold, the port ─────────────────────
export {
  isCompactionMarker,
  sliceFromLastCompacted,
  estimateTokens,
  computeThreshold,
} from "./compact.js";
export { buildCompactor, manualCompact } from "./compactor.js";
export { measureFixedOverhead, fixedOverheadTotal, type FixedOverhead } from "./overhead.js";

// ── sub-agents: the registry and its definition loader ────────────────────
export { SUBAGENT_TOOL_NAME, SUBAGENT_PROMPT, type SubAgentDetail } from "./subagent.js";
export { AgentRegistry, type AgentDefinition } from "./definitions.js";
export { loadAgentDefinitions, type AgentLoadOptions, type AgentLoadResult } from "./loader.js";
