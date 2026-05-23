import { listSessions, type Session } from "@nova/runtime";
import { dim, green, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { loadMessages } from "../persistence.js";
import { pickOne, pickerArrow } from "../picker.js";
import {
  firstUserLabel,
  formatTimestamp,
  switchToSession,
} from "../session-view.js";

export async function handleResume(ctx: CliContext, arg: string): Promise<void> {
  process.stdout.write("\n");
  const list = await listSessions(ctx.settings.sessionDir);
  if (list.length === 0) {
    process.stdout.write(`${dim("no sessions to resume.")}\n`);
    return;
  }

  let target: Session | null = null;

  if (arg) {
    target = list.find((s) => s.id === arg) ?? null;
    if (!target) {
      process.stdout.write(`${red(`session ${arg} not found.`)}\n`);
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
      process.stdout.write(`${dim("no sessions to resume.")}\n`);
      return;
    }
    const currentIdx = items.findIndex((it) => it.session.id === ctx.session.id);
    const pick = await pickOne<PickerItem>({
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
      process.stdout.write(`${dim("cancelled.")}\n`);
      return;
    }
    target = pick.session;
  }

  if (target.id === ctx.session.id) {
    process.stdout.write(`${dim("already on that session.")}\n`);
    return;
  }
  ctx.nextPlaceholder = "";
  await switchToSession(ctx, target);
}
