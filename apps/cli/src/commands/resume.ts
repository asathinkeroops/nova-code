import { listSessions, type Session } from "@nova/runtime";
import { dim, green, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { loadMessages } from "@nova/agent";
import { pickerArrow } from "../ui/picker.js";
import {
  firstUserLabel,
  formatTimestamp,
  switchToSession,
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
    type PickerItem = { session: Session; label: string };
    const items: PickerItem[] = [];
    for (const s of list) {
      let label: string;
      try {
        const msgs = await loadMessages(s.messagesPath);
        if (msgs.length === 0) continue;
        label = firstUserLabel(msgs);
      } catch (err) {
        const m = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
        label = red(`load failed: ${m.slice(0, 60)}`);
      }
      items.push({ session: s, label });
    }
    if (items.length === 0) {
      ctx.screen.card(dim("no sessions to resume."), { title: TITLE });
      return;
    }
    const currentIdx = items.findIndex((it) => it.session.id === ctx.session.id);
    const pick = await ctx.screen.pickOne<PickerItem>({
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
