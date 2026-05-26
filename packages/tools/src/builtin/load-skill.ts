import { z } from "zod";
import { xmlAttr, xmlEscape, type ToolHandler } from "@nova/core";

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
) => { body: string; location: string } | undefined;

export function createLoadSkillTool(
  getSkill: GetSkillFn,
  opts?: { maxResponseBytes?: number },
): ToolHandler {
  const maxBytes = opts?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return {
    definition: {
      name: "loadSkill",
      description: TOOL_DESCRIPTION,
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      const loaded = getSkill({ name: input.name });
      if (loaded === undefined) {
        return {
          output: `unknown skill: ${input.name}. Use /skills to list available skills.`,
          isError: true,
        };
      }
      const { body, location } = loaded;
      const payload =
        body.length > maxBytes ? `${body.slice(0, maxBytes)}\n${TRUNCATION_HINT}` : body;
      return {
        output:
          `<skill name="${xmlAttr(input.name)}" location="${xmlAttr(location)}">\n` +
          `${xmlEscape(payload)}\n</skill>`,
      };
    },
  };
}
