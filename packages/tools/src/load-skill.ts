import { z } from "zod";
import {
  type ToolContext,
  type ToolHandler,
  type ToolPromptSection,
} from "@nova/core";
import {
  xmlAttr,
  xmlEscape,
} from "@nova/base";
import {
  expandArgs,
  expandMentions,
  expandShell,
  expandVars,
  type PromptCommandRunner,
} from "@nova/base";
import { bashTool } from "./bash.js";
import { staticSection } from "./prompt.js";

/**
 * That skills exist at all. The INDEX of them (`<available-skills>`) is a
 * separate, host-built section: its byte budget depends on settings and the
 * active model, and the scan itself belongs to the host — see
 * `renderSkillsBlock` in the CLI.
 */
export const LOAD_SKILL_PROMPT: ToolPromptSection = staticSection({
  id: "load-skill",
  order: 50,
  requires: ["loadSkill"],
  text: "- Load specialized knowledge with loadSkill.",
});

const inputSchema = z.object({
  name: z.string().min(1).describe("Skill name as shown in <available-skills>."),
});

const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const TRUNCATION_HINT =
  "…(truncated. SKILL.md body exceeds maxResponseBytes; raise settings.skills.maxResponseBytes or shorten the skill.)";

const TOOL_DESCRIPTION =
  "Load the full instructions for a skill listed in <available-skills>. " +
  "Call this before acting on a task that matches a skill's description. " +
  "Returns the SKILL.md body; if the skill references supporting files, read those " +
  "with the Read tool. Read-only.";

export type GetSkillFn = (
  input: { name: string },
) => { body: string; location: string; pluginRoot?: string } | undefined;

export interface LoadSkillOptions {
  maxResponseBytes?: number;
  /**
   * When true, `` !`cmd` `` segments in a SKILL.md are replaced with a notice
   * instead of executed. Mirrors Claude Code's `disableSkillShellExecution`:
   * a skill body is authored content that runs without a permission prompt, so
   * deployments that don't want that need a way to switch it off wholesale.
   */
  disableShellExecution?: boolean;
}

/**
 * Substitute the variables a SKILL.md may reference. Both the `CLAUDE_`
 * (Claude Code compatible, so a skill copied in works unchanged) and `NOVA_`
 * spellings resolve to the same value.
 *
 * Unknown `${NAME}` references are left verbatim by `expandVars` — a skill that
 * documents some other tool's variable should read as written, not as a blank.
 */
function skillVars(opts: ExpandSkillOptions): Record<string, string> {
  const vars: Record<string, string> = {
    CLAUDE_SKILL_DIR: opts.location,
    NOVA_SKILL_DIR: opts.location,
    CLAUDE_PROJECT_DIR: opts.cwd,
    NOVA_PROJECT_DIR: opts.cwd,
  };
  // Absent values are left out of the map rather than mapped to "", so
  // expandVars leaves the reference verbatim. A skill that prints
  // `${CLAUDE_SESSION_ID}` should show a visible unresolved marker when there
  // is no session, not a confusing blank.
  if (opts.pluginRoot !== undefined) {
    vars["CLAUDE_PLUGIN_ROOT"] = opts.pluginRoot;
    vars["NOVA_PLUGIN_ROOT"] = opts.pluginRoot;
  }
  if (opts.sessionId !== undefined) {
    vars["CLAUDE_SESSION_ID"] = opts.sessionId;
    vars["NOVA_SESSION_ID"] = opts.sessionId;
  }
  if (opts.effort !== undefined) {
    vars["CLAUDE_EFFORT"] = opts.effort;
    vars["NOVA_EFFORT"] = opts.effort;
  }
  return vars;
}

export interface ExpandSkillOptions {
  /** The skill's own directory — the value behind `${*_SKILL_DIR}`. */
  location: string;
  /** Workspace root — the value behind `${*_PROJECT_DIR}`, and the `@path` base. */
  cwd: string;
  /** Owning plugin's root directory, when the skill came from one. `${*_PLUGIN_ROOT}`. */
  pluginRoot?: string;
  /** Session id for `${*_SESSION_ID}`. */
  sessionId?: string;
  /** Reasoning-effort level for `${*_EFFORT}`. */
  effort?: string;
  /**
   * Raw argument string for `$ARGUMENTS` / `$1`..`$N`. Only the user-invoked
   * `/{name} args` path supplies this; the model reaches a skill through
   * `loadSkill`, which takes a name and nothing else. Absent (the `loadSkill`
   * route) and empty (`/{name}` with nothing after it) differ: only the former
   * skips the argument stage entirely, so `$1` in the body still blanks out
   * rather than leaking when the user typed no arguments.
   */
  args?: string;
  /** Absent → `` !`cmd` `` is left verbatim. Injected so execution stays sandbox-confined. */
  runCommand?: PromptCommandRunner;
  disableShellExecution?: boolean;
}

/**
 * Build a bash-backed command runner for `` !`cmd` `` from a tool context. The
 * skill's inline shell then runs through the same tool, and the same sandbox
 * bridge, as any other subprocess the agent spawns.
 */
export function bashRunnerFor(ctx: ToolContext): PromptCommandRunner {
  return async (command) => {
    const result = await bashTool.run(
      { command },
      { cwd: ctx.cwd, ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}) },
    );
    return { output: result.output, isError: result.isError ?? false };
  };
}

/**
 * Expand a SKILL.md body for injection. Stages run in the same order as the
 * slash-command path (`expandCommandBody`): variables, then arguments, then
 * `@path`, then `` !`cmd` `` — each stage can feed the next, so
 * `@${NOVA_SKILL_DIR}/ref.md` and ``!`grep $1 file` `` both work.
 *
 * Arguments the body declares no placeholder for are appended as an
 * `ARGUMENTS:` line, exactly as `expandCommandBody` does. Most SKILL.md files
 * are written as standing instructions with no `$ARGUMENTS` in them, so
 * dropping the unconsumed text would hand the model a skill manual and no
 * request — the user's `/{name} do the thing` would arrive as `/{name}`.
 */
export async function expandSkillBody(body: string, opts: ExpandSkillOptions): Promise<string> {
  let text = expandVars(body, skillVars(opts));
  if (opts.args !== undefined) {
    const expanded = expandArgs(text, opts.args);
    text = expanded.text;
    if (expanded.unconsumed.length > 0) text += `\n\nARGUMENTS: ${expanded.unconsumed}`;
  }
  text = await expandMentions(text, opts.cwd);
  if (opts.disableShellExecution) return expandShell(text, { disabled: true });
  return expandShell(text, opts.runCommand ? { runCommand: opts.runCommand } : {});
}

/**
 * Render the full model-facing payload for a skill: expanded body, capped, and
 * wrapped in the `<skill>` envelope.
 *
 * Both invocation paths go through here so the model sees a byte-identical
 * presentation whether it called `loadSkill` itself or the user typed
 * `/{name}` — a skill that behaved differently depending on who reached it
 * would be a trap for anyone writing one.
 *
 * The cap is applied *after* expansion because embedded `@file` contents and
 * command output are exactly the growth the response budget exists to bound.
 */
export async function renderSkillPayload(
  name: string,
  body: string,
  opts: ExpandSkillOptions & { maxResponseBytes?: number },
): Promise<string> {
  const expanded = await expandSkillBody(body, opts);
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const payload =
    expanded.length > maxBytes ? `${expanded.slice(0, maxBytes)}\n${TRUNCATION_HINT}` : expanded;
  return (
    `<skill name="${xmlAttr(name)}" location="${xmlAttr(opts.location)}">\n` +
    `${xmlEscape(payload)}\n</skill>`
  );
}

export function createLoadSkillTool(
  getSkill: GetSkillFn,
  opts?: LoadSkillOptions,
): ToolHandler {
  const maxBytes = opts?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return {
    definition: {
      name: "loadSkill",
      description: TOOL_DESCRIPTION,
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);
      const loaded = getSkill({ name: input.name });
      if (loaded === undefined) {
        return {
          output: `unknown skill: ${input.name}. Use /skills to list available skills.`,
          isError: true,
        };
      }
      const { body, location } = loaded;
      return {
        output: await renderSkillPayload(input.name, body, {
          location,
          cwd: ctx.cwd,
          runCommand: bashRunnerFor(ctx),
          maxResponseBytes: maxBytes,
          // Session and effort come off the live ToolContext, not from options
          // captured at tool-construction time — `/effort` and `/resume` change
          // them mid-session.
          ...(loaded.pluginRoot !== undefined ? { pluginRoot: loaded.pluginRoot } : {}),
          ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
          ...(opts?.disableShellExecution ? { disableShellExecution: true } : {}),
        }),
      };
    },
  };
}
