import { accent, ACCENT_HEX, dim } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { pickerArrow } from "../ui/picker.js";

const TITLE = "/skills";

export async function handleSkills(ctx: CliContext): Promise<void> {
  // Both empty states render in the same top-ruled overlay as the list, so the
  // command always opens a 弹层 rather than dropping an inline card.
  const notice = (text: string): Promise<void> =>
    ctx.screen.viewer({
      lines: [dim(text)],
      header: accent(TITLE),
      footer: dim(t.common.footerClose),
      border: false,
      topRuleColor: ACCENT_HEX,
    });

  if (!ctx.skillsIndex.enabled) {
    await notice(t.skills.disabled);
    return;
  }
  // The provider's snapshot, not a fresh scan: `/skills`, the injected index
  // and the `/{name}` commands must agree about which skills exist. Run
  // `/commands reload` to refresh all three.
  const items = ctx.skillsIndex.list();
  if (items.length === 0) {
    await notice(t.skills.none);
    return;
  }
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.min(24, Math.max(...sorted.map((s) => s.name.length)));
  await ctx.screen.pickOne({
    items: sorted,
    header: `${accent(TITLE)}  ${dim(t.skills.count(sorted.length))}`,
    footer: dim(t.common.footerNavTopBottomClose),
    pageSize: 24,
    border: false,
    topRuleColor: ACCENT_HEX,
    render: (s, selected) => {
      const name = s.name.padEnd(nameWidth, " ");
      return `${pickerArrow(selected)} ${name}  ${s.description}`;
    },
  });
}
