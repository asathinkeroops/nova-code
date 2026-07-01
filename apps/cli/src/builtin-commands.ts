import type { CliContext } from "./ctx-types.js";
import {
  handleAgent,
  handleAgents,
  handleClear,
  handleCommands,
  handleCompact,
  handleContext,
  handleDiff,
  handleEffort,
  handleGoal,
  handleHelp,
  handleInit,
  handleLsp,
  handleMcp,
  handleModel,
  handlePlan,
  handlePredict,
  handleRename,
  handleResume,
  handleReview,
  handleRewind,
  handleSandbox,
  handleSkills,
  handleTasks,
  handleUsage,
} from "./commands/index.js";

export function registerBuiltinSlashCommands(ctx: CliContext): void {
  const handled = { kind: "handled" as const };
  ctx.registry.register({
    name: "help",
    description: "show this help",
    source: { kind: "builtin" },
    run: () => {
      handleHelp(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "effort",
    description: "show or change the extended-thinking level",
    argHint: "[<level>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleEffort(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "model",
    description: "show or switch the active model tier",
    argHint: "[<name>|<id>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleModel(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "clear",
    description: "start a fresh session (the current one stays resumable)",
    source: { kind: "builtin" },
    run: async () => {
      await handleClear(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "compact",
    description: "summarize history into a single message",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCompact(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "rename",
    description: "give this session a custom name (shown on the input frame)",
    argHint: "[<name>|clear]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleRename(ctx, args);
      return handled;
    },
  });
  ctx.registry.register({
    name: "resume",
    description: "switch to a saved session",
    argHint: "[<id>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleResume(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "rewind",
    description: "rewind history to a previous message (history after it is discarded)",
    argHint: "[<n>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleRewind(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "sandbox",
    description: "enable/disable the OS command sandbox for this session",
    argHint: "[on|off]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleSandbox(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "init",
    description: "generate or refresh NOVA.md by analyzing the codebase",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleInit(args),
  });
  ctx.registry.register({
    name: "plan",
    description: "plan a task via a read-only plan sub-agent (no implementation)",
    argHint: "<task goal>",
    source: { kind: "builtin" },
    run: (_c, args) => handlePlan(args),
  });
  ctx.registry.register({
    name: "diff",
    description: "browse uncommitted changes in a modal: file list → per-file diff",
    argHint: "[pathspec]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleDiff(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "review",
    description: "review the current uncommitted diff (read-only)",
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleReview(args),
  });
  ctx.registry.register({
    name: "goal",
    description: "set, show, or clear a success condition Nova auto-works toward",
    argHint: "[<condition>|clear]",
    source: { kind: "builtin" },
    run: (_c, args) => handleGoal(ctx, args.trim()),
  });
  ctx.registry.register({
    name: "predict",
    description: "show or toggle next-input prediction",
    argHint: "[on|off]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handlePredict(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "commands",
    description: "list registered slash commands; use `reload` to rescan files",
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCommands(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "skills",
    description: "list discovered skills (SKILL.md)",
    source: { kind: "builtin" },
    run: () => {
      handleSkills(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "agents",
    description: "list available sub-agent types; `reload` to rescan agent files",
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleAgents(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "agent",
    description: "delegate a task to a named sub-agent",
    argHint: "<name> <task>",
    source: { kind: "builtin" },
    run: (_c, args) => handleAgent(ctx, args),
  });
  ctx.registry.register({
    name: "tasks",
    description: "view and manage background commands (runInBackground)",
    argHint: "[list|stop <id|all>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleTasks(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "mcp",
    description: "open the MCP server menu (authenticate, reconnect, log out); `tools` to list",
    argHint: "[tools]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleMcp(ctx, args);
      return handled;
    },
  });
  ctx.registry.register({
    name: "lsp",
    description: "show configured language servers and their status",
    source: { kind: "builtin" },
    run: () => {
      handleLsp(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "usage",
    description: "show this session's token usage and cache hit rate",
    source: { kind: "builtin" },
    run: () => {
      handleUsage(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "context",
    description: "visualize the context window: what fills it, by category",
    source: { kind: "builtin" },
    run: () => {
      handleContext(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "exit",
    description: "leave the REPL",
    source: { kind: "builtin" },
    run: () => handled,
  });
  ctx.registry.register({
    name: "quit",
    description: "leave the REPL",
    source: { kind: "builtin" },
    run: () => handled,
  });
}
