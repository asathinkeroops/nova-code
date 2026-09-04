/**
 * `@nova/base` — the leaf foundation layer.
 *
 * Its membership rule is a dependency-graph rule, not a topic: everything that
 * imports no other `@nova/*` package and is not the agent kernel (`@nova/core`
 * owns that) lives here. So this package is deliberately four small, mutually
 * independent groups rather than one module — the subdirectories say which is
 * which, because the files themselves barely reference each other:
 *
 *   config/  the settings schema, the built-in model tables, and the resolvers
 *            that read a `Settings` — plus cost, which prices against that
 *            same table.
 *   host/    the bits that touch the process and the disk: logger, session
 *            directories, transcript writer, symlink-resolved paths.
 *   prompt/  the slash-command contract and the prompt-body expanders that
 *            turn `$ARGUMENTS` / `@file` / `!cmd` into text.
 *   text/    pure string helpers, shared across packages: XML escaping, YAML
 *            front matter, token estimation, thinking-level helpers.
 *
 * Adding a file here is only correct if it has no `@nova/*` import. If it
 * needs one, it belongs in the package that owns its topic.
 */

// ── config: settings schema, model tables, resolvers, pricing ───────────────
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
  providerEntrySchema,
  type ProviderEntry,
  activeProvider,
  activeModels,
  activeProviderProfile,
  activeProviderHeaders,
  activeProviderRequestParams,
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
  type HttpHeaders,
  requestParamsSchema,
  type RequestParams,
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
} from "./config/config.js";

export {
  BUILTIN_PROVIDER_MODELS,
  AUTO_WRITTEN_MODEL_TABLES,
  builtinModelsFor,
  mergeProviderModels,
  stripDefaultModels,
} from "./config/models.js";

export {
  adaptLegacyProviderConfig,
  migrateLegacyProviderConfig,
} from "./config/migration.js";

export {
  computeCost,
  formatMoney,
  type Currency,
  type ModelRates,
  type TokenCounts,
  type CostBreakdown,
} from "./config/cost.js";

// ── host: process- and disk-facing services ────────────────────────────────
export { createLogger, type Logger, type LoggerConfig } from "./host/logging.js";

export { Transcript, type TranscriptKind, type TranscriptRecord } from "./host/transcript.js";

export {
  createSession,
  listSessions,
  getSession,
  readSessionWorkspace,
  pruneSessions,
  selectExpiredSessions,
  type CreateSessionOptions,
  type Session,
  type SessionMetadata,
  type ExpiringSession,
  type PruneSessionsOptions,
  type PruneSessionsResult,
} from "./host/session.js";

export { canonicalizePath, canonicalizeRoots } from "./host/path-safety.js";

// ── prompt: slash-command contract + prompt-body expansion ─────────────────
export type {
  SlashArgSpec,
  SlashCommand,
  SlashCommandKind,
  SlashCommandSource,
  SlashOutcome,
  SlashRunCtx,
} from "./prompt/slash-types.js";

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
} from "./prompt/prompt-expansion.js";

// ── text: pure string helpers, shared across packages ──────────────────────
export { xmlEscape, xmlAttr } from "./text/xml.js";

export {
  parseFrontMatter,
  splitFrontMatter,
  frontMatterText,
  frontMatterBool,
  frontMatterList,
  type YamlValue,
} from "./text/front-matter.js";

export { THINKING_LEVELS, isThinkingLevel } from "./text/thinking.js";

export {
  DEFAULT_TOKEN_ESTIMATE,
  estimateTextTokens,
  isCjkCodePoint,
  type TokenEstimate,
} from "./text/tokens.js";
