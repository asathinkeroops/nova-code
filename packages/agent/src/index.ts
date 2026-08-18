export { assembleAgent, type AssembleAgentOptions } from "./assemble.js";
export {
  createMemoryPrompt,
  createOptions,
  createSessionStore,
  createToolHost,
  forwardLogger,
  forwardModel,
  transcriptSink,
  type AgentSettingsSlice,
  type MemoryPromptOptions,
  type SessionStoreOptions,
  type ToolHostOptions,
} from "./ports.js";
// The agent abstraction and its hooks live in @nova/core; re-export the symbols
// consumers need so they don't have to import from two packages.
export {
  HookRegistry,
  isBlockingPoint,
  staticPrompt,
  type Agent,
  type AgentContext,
  type Compactor,
  type HookDecision,
  type HookFn,
  type HookPayload,
  type HookPoint,
  type HookSpec,
  type PermissionGate,
  type TurnResult,
} from "@nova/core";
export { buildSystemPrompt } from "./system-prompt.js";
export {
  persistMessages,
  loadMessages,
  emptyCursor,
  type PersistCursor,
} from "./persistence.js";

// ── context: the memory bundle and the compaction boundary ────────────────
export {
  loadMemory,
  MEMORY_INDEX_FILENAME,
  type MemoryBundle,
  type MemoryLayer,
  type MemorySource,
  type LoadMemoryOptions,
} from "./memory.js";

export {
  COMPACT_MARKER,
  isCompactionMarker,
  sliceFromLastCompacted,
  estimateTokens,
  computeThreshold,
  shouldAutoCompact,
  autoCompact,
  type ThresholdOptions,
  type CompactTriggerOptions,
  type AutoCompactOptions,
  type AutoCompactResult,
} from "./compact.js";

export {
  buildCompactor,
  manualCompact,
  type AutoCompactPolicy,
  type BuildCompactorOptions,
  type ManualCompactOptions,
  type ManualCompactResult,
} from "./compactor.js";

export {
  measureFixedOverhead,
  fixedOverheadTotal,
  type FixedOverhead,
  type FixedOverheadInput,
} from "./overhead.js";

// ── sub-agents: the Task tool, its registry and its definition loader ──────
export {
  createSubAgentTool,
  SUBAGENT_TOOL_NAME,
  type SubAgentDeps,
  type SubAgentDetail,
} from "./subagent.js";
export { buildSubAgentSystemPrompt } from "./subagent-system-prompt.js";
export {
  AgentRegistry,
  BUILTIN_AGENTS,
  type AgentDefinition,
} from "./definitions.js";
export {
  loadAgentDefinitions,
  type AgentLoadOptions,
  type AgentLoadResult,
  type AgentsLogger,
} from "./loader.js";
