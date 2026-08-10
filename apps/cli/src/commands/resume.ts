import { listSessions, type Session } from "@nova/runtime";
import { ACCENT_HEX, dim, green } from "../colors.js";
import type { CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";
import { t } from "../i18n/index.js";
import { overlayNotice } from "./overlay-notice.js";
import {
  buildSessionRows,
  formatTimestamp,
  switchToSession,
  type SessionRow,
} from "../session.js";

const TITLE = "/resume";

export async function handleResume(ctx: CliContext, arg: string): Promise<void> {
  const list = await listSessions(ctx.settings.sessionDir);
  if (list.length === 0) {
    await overlayNotice(ctx, TITLE, [dim(t.resume.noSessions)]);
    return;
  }

  let target: Session | null = null;

  if (arg) {
    target = list.find((s) => s.id === arg) ?? null;
    if (!target) {
      ctx.screen.card(t.resume.notFound(arg), { kind: "error", title: TITLE });
      return;
    }
  } else {
    const items: SessionRow[] = await buildSessionRows(ctx.settings.sessionDir);
    if (items.length === 0) {
      await overlayNotice(ctx, TITLE, [dim(t.resume.noSessions)]);
      return;
    }
    const currentIdx = items.findIndex((it) => it.session.id === ctx.session.id);
    const pick = await ctx.screen.pickOne<SessionRow>({
      items,
      header: dim(t.resume.header),
      footer: dim(t.common.footerNavConfirm),
      pageSize: 10,
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      border: false,
      topRuleColor: ACCENT_HEX,
      render: ({ session: s, label }, isSelected) => {
        const marker = s.id === ctx.session.id ? green("*") : " ";
        return `${pickerArrow(isSelected)} ${marker} ${s.id}  ${dim(formatTimestamp(s.createdAt))}  ${dim(label)}`;
      },
    });
    if (!pick) return; // esc — leave the feed quiet
    target = pick.session;
  }

  if (target.id === ctx.session.id) {
    ctx.screen.card(dim(t.resume.alreadyOn), { title: TITLE });
    return;
  }
  ctx.nextPlaceholder = "";
  await switchToSession(ctx, target);
}
