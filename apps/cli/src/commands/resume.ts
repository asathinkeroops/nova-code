import { listSessions, type Session } from "@nova/runtime";
import { dim, green } from "../colors.js";
import type { CliContext } from "../context.js";
import { pickerArrow } from "../ui/picker.js";
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
    ctx.screen.card(dim("no sessions to resume."), { title: TITLE });
    return;
  }

  let target: Session | null = null;

  if (arg) {
    target = list.find((s) => s.id === arg) ?? null;
    if (!target) {
      ctx.screen.card(`session ${arg} not found.`, { kind: "error", title: TITLE });
      return;
    }
  } else {
    const items: SessionRow[] = await buildSessionRows(ctx.settings.sessionDir);
    if (items.length === 0) {
      ctx.screen.card(dim("no sessions to resume."), { title: TITLE });
      return;
    }
    const currentIdx = items.findIndex((it) => it.session.id === ctx.session.id);
    const pick = await ctx.screen.pickOne<SessionRow>({
      items,
      header: dim("select session to resume:"),
      footer: dim("↑↓ navigate · enter confirm · esc cancel"),
      pageSize: 10,
      initialIndex: currentIdx >= 0 ? currentIdx : 0,
      render: ({ session: s, label }, isSelected) => {
        const marker = s.id === ctx.session.id ? green("*") : " ";
        return `${pickerArrow(isSelected)} ${marker} ${s.id}  ${dim(formatTimestamp(s.createdAt))}  ${dim(label)}`;
      },
    });
    if (!pick) {
      ctx.screen.card(dim("cancelled."), { title: TITLE });
      return;
    }
    target = pick.session;
  }

  if (target.id === ctx.session.id) {
    ctx.screen.card(dim("already on that session."), { title: TITLE });
    return;
  }
  ctx.nextPlaceholder = "";
  await switchToSession(ctx, target);
}
