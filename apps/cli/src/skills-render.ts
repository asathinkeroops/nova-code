import type { SkillListItem } from "@nova/tools";

const HEADER = "<available-skills>";
const FOOTER =
  "Use the `loadSkill` tool with `name` to read full instructions before acting.";
const CLOSE = "</available-skills>";

/**
 * Render the skill index as an `<available-skills>` block for the system
 * prompt. Returns `""` for an empty list so the caller can drop the section
 * entirely. Sort is `name` ascending for cache stability across launches.
 */
export function renderSkillsBlock(items: SkillListItem[], maxBytes: number): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  // Reserve bytes for the fixed scaffolding: header + footer + close + the
  // three newlines that join them. We track usage with utf8 byte counts so
  // multi-byte descriptions don't slip past the cap.
  const scaffold =
    Buffer.byteLength(HEADER, "utf8") +
    Buffer.byteLength(FOOTER, "utf8") +
    Buffer.byteLength(CLOSE, "utf8") +
    3; // 3 joining newlines

  const lines: string[] = [];
  let used = scaffold;
  let truncated = 0;

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i] as SkillListItem;
    const line = `- ${s.name}: ${s.description}`;
    // +1 for the newline that joins this line to the next.
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (used + lineBytes > maxBytes) {
      truncated = sorted.length - i;
      break;
    }
    lines.push(line);
    used += lineBytes;
  }

  if (truncated > 0) {
    lines.push(
      `…${truncated} more skills truncated; raise settings.skills.maxIndexBytes to see all`,
    );
  }

  return `${HEADER}\n${lines.join("\n")}\n${FOOTER}\n${CLOSE}`;
}
