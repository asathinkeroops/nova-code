import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import {
  clearSessionName,
  normalizeSessionName,
  saveSessionName,
} from "../session-name.js";

const TITLE = "/rename";

/**
 * Give the active session a custom display name, shown as a badge on the
 * InputBox top frame. `/rename <name>` sets it (persisted to the session dir so
 * it survives resume); `/rename clear` removes it; bare `/rename` reports the
 * current name.
 */
export async function handleRename(ctx: CliContext, arg: string): Promise<void> {
  const input = arg.trim();

  if (input === "") {
    ctx.screen.card(
      ctx.sessionName
        ? t.rename.currentName(ctx.sessionName)
        : t.rename.noNameSet,
      { title: TITLE },
    );
    return;
  }

  if (input === "clear") {
    await clearSessionName(ctx.session.id);
    ctx.sessionName = null;
    ctx.screen.setSessionName(null);
    ctx.screen.card(t.rename.cleared, { title: TITLE });
    return;
  }

  const name = normalizeSessionName(input);
  if (name.length === 0) {
    ctx.screen.card(t.rename.emptyError, {
      kind: "warn",
      title: TITLE,
    });
    return;
  }
  await saveSessionName(ctx.session.id, name);
  ctx.sessionName = name;
  ctx.screen.setSessionName(name);
  ctx.screen.card(t.rename.renamedTo(name), { title: TITLE });
}
