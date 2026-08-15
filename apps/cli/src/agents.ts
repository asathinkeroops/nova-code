import { loadAgentDefinitions, type AgentLoadOptions, type AgentLoadResult } from "@nova/agent";
import type { Logger, Settings } from "@nova/runtime";

/**
 * Build the agent-definition loader options from settings. Shared by the
 * startup load (in createContext) and `/agents reload`, so the discovery dirs
 * stay in one place.
 */
export function agentLoadOpts(settings: Settings, cwd: string, logger: Logger): AgentLoadOptions {
  return {
    cwd,
    ...(settings.subagent.projectDirs ? { projectDirs: settings.subagent.projectDirs } : {}),
    ...(settings.subagent.userPaths ? { userPaths: settings.subagent.userPaths } : {}),
    ...(settings.subagent.extraDirs ? { extraDirs: settings.subagent.extraDirs } : {}),
    logger,
  };
}

/** Scan custom sub-agent definitions from disk using the configured dirs. */
export function loadAgents(settings: Settings, cwd: string, logger: Logger): AgentLoadResult {
  return loadAgentDefinitions(agentLoadOpts(settings, cwd, logger));
}
