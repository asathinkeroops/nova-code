export {
  settingsSchema,
  permissionRuleSchema,
  loadSettings,
  parseSettings,
  resolveLanguage,
  API_KEY_ENV,
  apiKeyFromEnv,
  resolveApiKey,
  saveSettings,
  saveModelProfileOverride,
  isDangerousBash,
  DEFAULT_CONFIG_PATH,
  DEFAULT_MEMORY_FILENAMES,
  DEFAULT_AUTO_MEMORY_MAX_ENTRIES,
  AUTO_MEMORY_ROOT_SEGMENTS,
  encodeProjectPath,
  defaultAutoMemoryDir,
  resolveAutoMemoryDir,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  modelPricingSchema,
  type ModelPricing,
  resolveModelId,
  resolveContextWindowSize,
  resolveSkillsIndexBudget,
  resolveMaxTokens,
  resolveModelModalities,
  resolveThinkingLevel,
  thinkingLevelSchema,
  DEFAULT_THINKING_LEVEL,
  type ThinkingLevel,
  modelDescription,
  DEFAULT_MODEL_DESCRIPTIONS,
  DEFAULT_MODEL_TIER,
  DEFAULT_CHEAP_TIER,
  REQUIRED_MODEL_TIERS,
  DEFAULT_GOAL,
  modelProfileSchema,
  modelEntrySchema,
  type ModelProfile,
  type ModelEntry,
  modelModalitiesSchema,
  type ModelModalities,
  mcpServerSchema,
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  hookCommandSchema,
  hooksConfigSchema,
  loadProjectHooks,
  mergeHooks,
  HOOK_EVENT_NAMES,
  PROJECT_HOOK_FILES,
  type HookCommandConfig,
  type HooksConfig,
  type HookEventName,
  type ProjectHooksResult,
  type Settings,
  pluginSourceSchema,
  type PluginSource,
  type PermissionRule,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpHttpServerConfig,
} from "./config.js";

export {
  BUILTIN_PROVIDER_MODELS,
  AUTO_WRITTEN_MODEL_TABLES,
  builtinModelsFor,
  mergeBuiltinModels,
  stripDefaultModels,
} from "./models.js";

export { createLogger, type Logger, type LoggerConfig } from "./logging.js";

export { Transcript, type TranscriptKind, type TranscriptRecord } from "./transcript.js";
export {
  computeCost,
  formatMoney,
  type Currency,
  type ModelRates,
  type TokenCounts,
  type CostBreakdown,
} from "./cost.js";

export { canonicalizePath, canonicalizeRoots } from "./path-safety.js";
export type {
  SlashArgSpec,
  SlashCommand,
  SlashCommandKind,
  SlashCommandSource,
  SlashOutcome,
  SlashRunCtx,
} from "./slash-types.js";
export {
  expandVars,
  expandArgs,
  expandDollarArgs,
  type ExpandArgsOptions,
  type ExpandArgsResult,
  expandMentions,
  expandShell,
  SHELL_DISABLED_NOTICE,
  type PromptCommandRunner,
  type ExpandShellOptions,
} from "./prompt-expansion.js";

export {
  createSession,
  listSessions,
  getSession,
  pruneSessions,
  selectExpiredSessions,
  type Session,
  type ExpiringSession,
  type PruneSessionsOptions,
  type PruneSessionsResult,
} from "./session.js";

// ── shared text / token utilities (moved out of @nova/core, which is now the
// agent kernel only) ─────────────────────────────────────────────────────────
export { xmlEscape, xmlAttr } from "./xml.js";
export {
  parseFrontMatter,
  splitFrontMatter,
  frontMatterText,
  frontMatterBool,
  frontMatterList,
  type YamlValue,
} from "./front-matter.js";
export { THINKING_BUDGETS, THINKING_LEVELS, isThinkingLevel, resolveBudget } from "./thinking.js";
export {
  DEFAULT_TOKEN_ESTIMATE,
  estimateTextTokens,
  isCjkCodePoint,
  type TokenEstimate,
} from "./tokens.js";
