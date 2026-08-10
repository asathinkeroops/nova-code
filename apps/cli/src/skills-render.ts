import type { SkillListItem } from "@nova/tools";

const HEADER = "<available-skills>";
const FOOTER =
  "Use the `loadSkill` tool with `name` to read full instructions before acting.";
const CLOSE = "</available-skills>";

export interface SkillsBlockOptions {
  /**
   * Byte budget for the whole block. Overflow degrades entries to name-only
   * (see {@link renderSkillsBlock}); it never removes a skill.
   */
  budgetBytes: number;
  /** Per-entry cap on the description text, marked with `…` when it bites. */
  maxDescriptionBytes: number;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Cap a description at `max` *bytes* without splitting a multi-byte character.
 * Nova budgets in utf8 bytes rather than characters because a CJK description
 * costs 3 bytes per character — counting characters would let a Chinese skill
 * index overrun its budget threefold.
 */
function capDescription(desc: string, max: number): string {
  if (bytes(desc) <= max) return desc;
  const ellipsis = "…";
  const room = max - bytes(ellipsis);
  if (room <= 0) return ellipsis;
  const buf = Buffer.from(desc, "utf8");
  let end = room;
  // Back off to the start of the truncated code point so we never emit U+FFFD.
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}${ellipsis}`;
}

/**
 * Render the skill index as an `<available-skills>` block for the system
 * prompt. Returns `""` for an empty list so the caller can drop the section
 * entirely.
 *
 * Budget behaviour mirrors Claude Code: when the full listing does not fit,
 * entries are degraded to **name-only** (`- name`) rather than dropped, so
 * every skill stays invocable — a skill the model cannot see the name of might
 * as well not exist, whereas a skill with no description can still be reached
 * by name, and `loadSkill` returns its real instructions anyway. Descriptions
 * are kept for as many skills as the budget allows, cheapest-first so the
 * count of skills that keep one is maximised.
 *
 * Ordering is `name` ascending and the degrade decision is a pure function of
 * the input, so the same skill set always renders byte-identical — the block
 * sits in the system prompt, which must stay frozen within a session for the
 * prefix cache to hit.
 */
export function renderSkillsBlock(items: SkillListItem[], opts: SkillsBlockOptions): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  // Reserve bytes for the fixed scaffolding: header + footer + close + the
  // three newlines that join them.
  const scaffold = bytes(HEADER) + bytes(FOOTER) + bytes(CLOSE) + 3;

  const entries = sorted.map((s) => {
    const nameOnly = `- ${s.name}`;
    const full = `${nameOnly}: ${capDescription(s.description, opts.maxDescriptionBytes)}`;
    return { nameOnly, full, cost: bytes(full) - bytes(nameOnly) };
  });

  // +1 per entry for the newline joining it to the next line.
  const nameOnlyTotal = entries.reduce((n, e) => n + bytes(e.nameOnly) + 1, scaffold);
  const fullTotal = entries.reduce((n, e) => n + e.cost, nameOnlyTotal);

  let lines: string[];
  if (fullTotal <= opts.budgetBytes) {
    lines = entries.map((e) => e.full);
  } else {
    // Grant descriptions greedily from the cheapest up. Ties break on name via
    // the stable sort over the already name-sorted array, keeping the result
    // deterministic for the prefix cache.
    let remaining = opts.budgetBytes - nameOnlyTotal;
    const keepFull = new Set<number>();
    const order = entries.map((e, i) => ({ i, cost: e.cost })).sort((a, b) => a.cost - b.cost);
    for (const { i, cost } of order) {
      if (cost > remaining) continue;
      keepFull.add(i);
      remaining -= cost;
    }
    lines = entries.map((e, i) => (keepFull.has(i) ? e.full : e.nameOnly));
  }

  return `${HEADER}\n${lines.join("\n")}\n${FOOTER}\n${CLOSE}`;
}
