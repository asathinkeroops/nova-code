/**
 * The slash-command contract, type-only.
 *
 * The registry, the `.md` file loader and the body expander all live in the
 * CLI (`apps/cli/src/slash-registry.ts`) — they are host surface, not library
 * code. Only the *shape* lives here, because `@nova/mcp` bridges each MCP
 * prompt into a `SlashCommand` and would otherwise have to depend on the app.
 * This module declares types exclusively: it must stay free of runtime values
 * so it costs nothing to import from either side.
 */

export type SlashCommandKind = "builtin" | "user" | "project" | "mcp" | "skill" | "plugin";

export interface SlashCommandSource {
  kind: SlashCommandKind;
  /** Absolute path of the .md file; undefined for builtins. */
  path?: string;
  /** Same-named commands lower in priority that were shadowed by this one. */
  shadowedBy?: Array<{ kind: SlashCommandKind; path: string }>;
}

export interface SlashArgSpec {
  name: string;
  required?: boolean;
  default?: string;
}

export interface SlashRunCtx {
  cwd: string;
  /**
   * Execute a shell command for Claude-Code-style `` !`cmd` `` interpolation in
   * a command body. Injected by the host so execution stays sandbox-confined
   * and the command layer keeps no dependency on the tool/sandbox layer. When
   * absent, `` !`cmd` `` segments are left verbatim.
   */
  runCommand?: (command: string) => Promise<{ output: string; isError: boolean }>;
}

export type SlashOutcome =
  | { kind: "handled" }
  | { kind: "prompt"; text: string }
  | { kind: "error"; message: string };

export interface SlashCommand {
  /** Bare name without the leading "/". */
  name: string;
  description: string;
  /** Short hint shown next to the name in /help, e.g. "[focus]". */
  argHint?: string;
  source: SlashCommandSource;
  args?: SlashArgSpec[];
  run: (ctx: SlashRunCtx, args: string) => Promise<SlashOutcome> | SlashOutcome;
}
