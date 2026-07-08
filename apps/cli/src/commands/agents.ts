import type { AgentDefinition } from "@nova/subagent";
import { loadAgents } from "../agents.js";
import { accent, dim, PURPLE_HEX } from "../colors.js";
import type { CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/agents";

const SOURCE_TAG: Record<AgentDefinition["source"], string> = {
  builtin: "[builtin]",
  user: "[user]   ",
  project: "[project]",
};

/** Short parenthetical of a definition's tool/model constraints, or "". */
function metaOf(d: AgentDefinition): string {
  const bits: string[] = [];
  if (d.readOnly) bits.push("read-only");
  if (d.allowTools && d.allowTools.length > 0) bits.push(`tools: ${d.allowTools.join(",")}`);
  if (d.model) bits.push(`model: ${d.model}`);
  return bits.length > 0 ? ` ${dim(`(${bits.join("; ")})`)}` : "";
}

export async function handleAgents(ctx: CliContext, arg: string): Promise<void> {
  if (!ctx.settings.subagent.enabled) {
    ctx.screen.card(dim("sub-agents disabled in settings."), { title: TITLE });
    return;
  }

  if (arg === "reload") {
    const t0 = Date.now();
    const { defs, errors } = loadAgents(ctx.settings, ctx.workspace, ctx.logger);
    const skipped = ctx.agents.replaceCustom(defs);
    const ms = Date.now() - t0;
    const loaded = defs.length - skipped.length;
    const tails: string[] = [];
    if (skipped.length > 0) tails.push(`${skipped.length} shadowed by built-ins (${skipped.join(", ")})`);
    if (errors.length > 0) tails.push(`${errors.length} error(s) — see log`);
    const tail = tails.length > 0 ? ` · ${tails.join(" · ")}` : "";
    ctx.screen.card(`reloaded ${loaded} custom agent(s) in ${ms}ms${tail}`, { title: TITLE });
    return;
  }

  if (arg) {
    ctx.screen.card(`unknown subcommand "${arg}". try /agents or /agents reload.`, {
      kind: "error",
      title: TITLE,
    });
    return;
  }

  const defs = ctx.agents.list();
  const nameWidth = Math.min(24, Math.max(...defs.map((d) => d.name.length)));
  await ctx.screen.pickOne({
    items: defs,
    header: `${accent(TITLE)}  ${dim(`${defs.length} agent${defs.length === 1 ? "" : "s"}`)}`,
    footer: dim(
      "delegate with /agent <name> <task> · ↑↓ navigate · ⌃a/⌃e top/bottom · enter/esc close",
    ),
    pageSize: 24,
    border: false,
    topRuleColor: PURPLE_HEX,
    render: (d, selected) => {
      const tag = dim(SOURCE_TAG[d.source]);
      const name = d.name.padEnd(nameWidth, " ");
      return `${pickerArrow(selected)} ${tag} ${name}  ${d.description}${metaOf(d)}`;
    },
  });
}
