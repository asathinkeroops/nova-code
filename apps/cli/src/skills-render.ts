import { createHash } from "node:crypto";
import type { SkillListItem } from "@nova/tools";

const HEADER = "<available-skills>";
const FOOTER =
  "Use the `loadSkill` tool with `name` to read full instructions before acting.";
const CLOSE = "</available-skills>";
const CHANGED_LINE = "skills has changed";
const EMPTY_LINE = "no skills are currently available";
const EMPTY_VERSION = "empty";

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

interface LineOptions {
  budgetBytes: number;
  maxDescriptionBytes: number;
  /** Bytes the surrounding scaffolding costs before any entry is rendered. */
  scaffoldBytes: number;
}

/**
 * The entry lines, sorted and budget-degraded. Pure: the same items always
 * produce the same lines, which is what keeps the injected message byte-stable
 * (and therefore the version fingerprint meaningful).
 */
function skillLines(items: SkillListItem[], opts: LineOptions): string[] {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));

  const entries = sorted.map((s) => {
    const nameOnly = `- ${s.name}`;
    const full = `${nameOnly}: ${capDescription(s.description, opts.maxDescriptionBytes)}`;
    return { nameOnly, full, cost: bytes(full) - bytes(nameOnly) };
  });

  // +1 per entry for the newline joining it to the next line.
  const nameOnlyTotal = entries.reduce((n, e) => n + bytes(e.nameOnly) + 1, opts.scaffoldBytes);
  const fullTotal = entries.reduce((n, e) => n + e.cost, nameOnlyTotal);

  if (fullTotal <= opts.budgetBytes) return entries.map((e) => e.full);

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
  return entries.map((e, i) => (keepFull.has(i) ? e.full : e.nameOnly));
}

/**
 * Render the skill index as an `<available-skills>` block for the system
 * prompt. Returns `""` for an empty list so the caller can drop the section
 * entirely.
 *
 * Kept for the legacy system-prompt path and its tests; the message injector
 * uses {@link renderSkillsMessage}, which omits the footer (the system prompt
 * carries that instruction once) and adds a version fingerprint.
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
  const lines = skillLines(items, {
    ...opts,
    // Reserve bytes for the fixed scaffolding: header + footer + close + the
    // three newlines that join them.
    scaffoldBytes: bytes(HEADER) + bytes(FOOTER) + bytes(CLOSE) + 3,
  });
  return `${HEADER}\n${lines.join("\n")}\n${FOOTER}\n${CLOSE}`;
}

export interface RenderedSkillsMessage {
  /** The message body used on first injection. */
  text: string;
  /** The same list preceded by the "skills has changed" marker. */
  changedText: string;
  /**
   * Fingerprint of the LIST PAYLOAD only (not the marker, not the footer).
   * Stable for the same rendered list, so a `meta.version` comparison tells
   * the injector whether the model can still see the current content.
   */
  version: string;
}

/**
 * Render the skill index as a standalone message. The model reads it from the
 * conversation rather than from the system prompt, so a skill-set change costs
 * a tail append instead of a full prefix-cache reset.
 */
export function renderSkillsMessage(
  items: SkillListItem[],
  opts: SkillsBlockOptions,
): RenderedSkillsMessage {
  if (items.length === 0) {
    return {
      text: `${HEADER}\n${EMPTY_LINE}\n${CLOSE}`,
      changedText: `${HEADER}\n${CHANGED_LINE}\n${EMPTY_LINE}\n${CLOSE}`,
      version: EMPTY_VERSION,
    };
  }

  const lines = skillLines(items, {
    ...opts,
    // header + close + the two newlines joining them; no footer in the message.
    scaffoldBytes: bytes(HEADER) + bytes(CLOSE) + 2,
  });
  const payload = lines.join("\n");
  const version = createHash("sha1").update(payload).digest("hex").slice(0, 12);
  return {
    text: `${HEADER}\n${payload}\n${CLOSE}`,
    changedText: `${HEADER}\n${CHANGED_LINE}\n${payload}\n${CLOSE}`,
    version,
  };
}
