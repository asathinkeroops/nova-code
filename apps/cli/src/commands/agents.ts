import type { AgentDefinition } from "@nova/subagent";
import { loadAgents } from "../agents.js";
import { accent, dim, PURPLE_HEX } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/agents";

/** Short parenthetical of a definition's tool/model constraints, or "". */
function metaOf(d: AgentDefinition): string {
  const bits: string[] = [];
  if (d.readOnly) bits.push(t.agents.metaReadOnly);
  if (d.allowTools && d.allowTools.length > 0) bits.push(t.agents.metaTools(d.allowTools.join(",")));
  if (d.model) bits.push(t.agents.metaModel(d.model));
  return bits.length > 0 ? ` ${dim(`(${bits.join("; ")})`)}` : "";
}

export async function handleAgents(ctx: CliContext, arg: string): Promise<void> {
  if (!ctx.settings.subagent.enabled) {
    ctx.screen.card(dim(t.agents.disabled), { title: TITLE });
    return;
  }

  if (arg === "reload") {
    const t0 = Date.now();
    const { defs, errors } = loadAgents(ctx.settings, ctx.workspace, ctx.logger);
    const skipped = ctx.agents.replaceCustom(defs);
    const ms = Date.now() - t0;
    const loaded = defs.length - skipped.length;
    const tails: string[] = [];
    if (skipped.length > 0) tails.push(t.agents.reloadShadowed(skipped.length, skipped.join(", ")));
    if (errors.length > 0) tails.push(t.agents.reloadErrors(errors.length));
    const tail = tails.length > 0 ? ` · ${tails.join(" · ")}` : "";
    ctx.screen.card(t.agents.reloadedCard(loaded, ms, tail), { title: TITLE });
    return;
  }

  if (arg) {
    ctx.screen.card(t.agents.unknownSubcommand(arg), {
      kind: "error",
      title: TITLE,
    });
    return;
  }

  const defs = ctx.agents.list();
  const nameWidth = Math.min(24, Math.max(...defs.map((d) => d.name.length)));
  await ctx.screen.pickOne({
    items: defs,
    header: `${accent(TITLE)}  ${dim(t.agents.headerCount(defs.length))}`,
    footer: dim(t.agents.pickerFooter),
    pageSize: 24,
    border: false,
    topRuleColor: PURPLE_HEX,
    render: (d, selected) => {
      const tag = dim(t.agents.sourceTag[d.source]);
      const name = d.name.padEnd(nameWidth, " ");
      return `${pickerArrow(selected)} ${tag} ${name}  ${d.description}${metaOf(d)}`;
    },
  });
}
