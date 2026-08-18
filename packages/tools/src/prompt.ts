/**
 * Gathering tool-bound system-prompt text.
 *
 * A tool family declares its guidance as a {@link ToolPromptSection} next to
 * the factory that builds its handlers; the host collects those, adds whatever
 * only it can build (the skills index, whose byte budget depends on settings
 * and the active model), and renders one block against the FINAL tool set.
 *
 * "Final" is the whole point. The gate is the tool set the model will actually
 * be sent — after MCP has connected, after `createSubAgent` and the plan-mode
 * pair are registered, and after `permissions.deny` has removed tools from the
 * registry. Deriving the same conditions a second time from settings is how the
 * prompt ends up advertising a tool that is not there.
 */

import type { ToolDefinition, ToolPromptContext, ToolPromptSection } from "@nova/core";

const OPEN = "<tool-guidance>";
const CLOSE = "</tool-guidance>";

const DEFAULT_ORDER = 100;

export interface RenderedToolPrompts {
  /** The sections that survived gating, in emission order, each with its text. */
  sections: Array<{ id: string; text: string }>;
  /** Those sections wrapped in `<tool-guidance>`; `""` when none survived. */
  text: string;
}

function gatePasses(section: ToolPromptSection, present: ReadonlySet<string>): boolean {
  if (section.requires && !section.requires.every((n) => present.has(n))) return false;
  if (section.requiresAny && !section.requiresAny.some((n) => present.has(n))) return false;
  return true;
}

/**
 * Render the tool-guidance block for one tool set.
 *
 * Pure and byte-deterministic given the same inputs — the sort is stable on
 * `order` and duplicate ids are dropped keeping the first, so the result never
 * depends on registration order within an order tier. See
 * {@link ToolPromptSection} for why that matters.
 */
export function renderToolPrompts(
  tools: readonly ToolDefinition[],
  sections: readonly ToolPromptSection[],
): RenderedToolPrompts {
  const ctx: ToolPromptContext = { present: new Set(tools.map((t) => t.name)) };

  const seen = new Set<string>();
  const eligible: Array<{ section: ToolPromptSection; order: number; at: number }> = [];
  for (const section of sections) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    if (!gatePasses(section, ctx.present)) continue;
    eligible.push({ section, order: section.order ?? DEFAULT_ORDER, at: eligible.length });
  }
  eligible.sort((a, b) => a.order - b.order || a.at - b.at);

  const rendered: Array<{ id: string; text: string }> = [];
  for (const { section } of eligible) {
    const text = section.render(ctx).trim();
    if (text) rendered.push({ id: section.id, text });
  }

  if (rendered.length === 0) return { sections: [], text: "" };
  // Bullets pack together; a tagged block (the skills index) gets a blank line
  // so it reads as its own region rather than as a run-on list item.
  let body = "";
  for (const [i, r] of rendered.entries()) {
    if (i > 0) body += r.text.startsWith("-") ? "\n" : "\n\n";
    body += r.text;
  }
  return { sections: rendered, text: `${OPEN}\n${body}\n${CLOSE}` };
}

/**
 * The subset of `names` that is actually present, joined for prose — so a
 * family's guidance never names a tool the denylist removed. Order follows
 * `names`, keeping the output deterministic.
 */
export function presentList(ctx: ToolPromptContext, names: readonly string[]): string {
  return names.filter((n) => ctx.present.has(n)).join(" / ");
}

/** A section over a fixed string — the shape most tool families need. */
export function staticSection(
  spec: Omit<ToolPromptSection, "render"> & { text: string },
): ToolPromptSection {
  const { text, ...rest } = spec;
  return { ...rest, render: () => text };
}
