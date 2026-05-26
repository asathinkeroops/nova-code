export {
  createAgent,
  type Agent,
  type AgentDeps,
  type AgentSettingsSlice,
  type TurnResult,
} from "./agent.js";
// Hooks live in @nova/core; re-export the symbols agent consumers need so
// they don't have to import from two packages.
export {
  HookRegistry,
  isBlockingPoint,
  type HookDecision,
  type HookFn,
  type HookPayload,
  type HookPoint,
  type HookSpec,
} from "@nova/core";
export { buildSystemPrompt } from "./system-prompt.js";
export {
  persistMessages,
  loadMessages,
  emptyCursor,
  type PersistCursor,
} from "./persistence.js";
