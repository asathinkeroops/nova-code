import type { CliContext } from "./ctx-types.js";
import { t } from "./i18n/index.js";
import {
  handleAgent,
  handleAgents,
  handleClear,
  handleCommands,
  handleCompact,
  handleContext,
  handleDiff,
  handleDoctor,
  handleEffort,
  handleGoal,
  handleHelp,
  handleInit,
  handleLoop,
  handleLsp,
  handleMcp,
  handleModel,
  handleNovaCodeGuide,
  handleNovaCodeGuideUpdate,
  handlePlan,
  handlePlugin,
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
    description: t.commands.help,
    source: { kind: "builtin" },
    run: async () => {
      await handleHelp(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "effort",
    description: t.commands.effort,
    argHint: "[<level>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleEffort(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "loop",
    description: t.commands.loop,
    argHint: "<interval> <prompt|/cmd> | stop",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleLoop(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "model",
    description: t.commands.model,
    argHint: "[<name>|<id>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleModel(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "clear",
    description: t.commands.clear,
    source: { kind: "builtin" },
    run: async () => {
      await handleClear(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "compact",
    description: t.commands.compact,
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCompact(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "rename",
    description: t.commands.rename,
    argHint: "[<name>|clear]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleRename(ctx, args);
      return handled;
    },
  });
  ctx.registry.register({
    name: "resume",
    description: t.commands.resume,
    argHint: "[<id>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleResume(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "rewind",
    description: t.commands.rewind,
    argHint: "[<n>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleRewind(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "sandbox",
    description: t.commands.sandbox,
    argHint: "[on|off]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleSandbox(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "init",
    description: t.commands.init,
    argHint: "[focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleInit(args),
  });
  ctx.registry.register({
    name: "plan",
    description: t.commands.plan,
    argHint: "<task goal>",
    source: { kind: "builtin" },
    run: (_c, args) => handlePlan(args),
  });
  ctx.registry.register({
    name: "diff",
    description: t.commands.diff,
    argHint: "[pathspec]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleDiff(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "review",
    description: t.commands.review,
    argHint: "[PR# | focus…]",
    source: { kind: "builtin" },
    run: (_c, args) => handleReview(args),
  });
  ctx.registry.register({
    name: "goal",
    description: t.commands.goal,
    argHint: "[<condition>|clear]",
    source: { kind: "builtin" },
    run: (_c, args) => handleGoal(ctx, args.trim()),
  });
  ctx.registry.register({
    name: "predict",
    description: t.commands.predict,
    argHint: "[on|off]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handlePredict(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "commands",
    description: t.commands.commands,
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleCommands(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "skills",
    description: t.commands.skills,
    source: { kind: "builtin" },
    run: async () => {
      await handleSkills(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "agents",
    description: t.commands.agents,
    argHint: "[reload]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleAgents(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "agent",
    description: t.commands.agent,
    argHint: "<name> <task>",
    source: { kind: "builtin" },
    run: (_c, args) => handleAgent(ctx, args),
  });
  ctx.registry.register({
    name: "nova-code-guide",
    description: t.commands.novaCodeGuide,
    argHint: "<question about Nova>",
    source: { kind: "builtin" },
    run: (_c, args) => handleNovaCodeGuide(ctx, args),
  });
  ctx.registry.register({
    name: "nova-code-guide-update",
    description: t.commands.novaCodeGuideUpdate,
    source: { kind: "builtin" },
    run: () => handleNovaCodeGuideUpdate(ctx),
  });
  ctx.registry.register({
    name: "tasks",
    description: t.commands.tasks,
    argHint: "[list|stop <id|all>]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleTasks(ctx, args.trim());
      return handled;
    },
  });
  ctx.registry.register({
    name: "mcp",
    description: t.commands.mcp,
    argHint: "[tools]",
    source: { kind: "builtin" },
    run: async (_c, args) => {
      await handleMcp(ctx, args);
      return handled;
    },
  });
  ctx.registry.register({
    name: "lsp",
    description: t.commands.lsp,
    source: { kind: "builtin" },
    run: async () => {
      await handleLsp(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "doctor",
    description: t.commands.doctor,
    source: { kind: "builtin" },
    run: async () => handleDoctor(ctx),
  });
  ctx.registry.register({
    name: "plugin",
    description: t.commands.plugin,
    source: { kind: "builtin" },
    run: async () => {
      await handlePlugin(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "usage",
    description: t.commands.usage,
    source: { kind: "builtin" },
    run: async () => {
      await handleUsage(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "context",
    description: t.commands.context,
    source: { kind: "builtin" },
    run: async () => {
      await handleContext(ctx);
      return handled;
    },
  });
  ctx.registry.register({
    name: "exit",
    description: t.commands.exit,
    source: { kind: "builtin" },
    run: () => handled,
  });
  ctx.registry.register({
    name: "quit",
    description: t.commands.quit,
    source: { kind: "builtin" },
    run: () => handled,
  });
}
