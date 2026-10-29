import {
  blocksOf,
  extractText,
  markSynthetic,
  type MessageParam,
  type ThinkingLevel,
  type ToolDefinition,
} from "@nova/core";
import { isCompactionMarker } from "@nova/agent";
import { resolveSkillsIndexBudget, type Logger, type Settings } from "@nova/base";
import { getSkillList, refreshSkills, type SkillListItem, type SkillsOptions } from "@nova/tools";
import type { LoadedPlugin } from "./plugins/loader.js";
import { createSkillsOptions } from "./skills-options.js";
import { renderSkillsMessage } from "./skills-render.js";

/**
 * The current model-facing skill index, plus the material every consumer needs
 * to keep its view in sync.
 *
 * The provider is a SNAPSHOT: `getSkillList` is memoized, so the index only
 * changes when somebody calls `refresh()` — at a session boundary or on an
 * explicit `/commands reload`. That is deliberate. Re-scanning on every request
 * would turn a rare, user-driven event into an unbounded stream of file-system
 * traffic and, worse, let an unnoticed edit change what the model sees
 * mid-task.
 */
export interface SkillsIndexSnapshot {
  /** `""` when skills are disabled; the empty-list block otherwise. */
  text: string;
  /** Same list, preceded by the "skills has changed" marker. */
  changedText: string;
  /** Fingerprint of the list payload; compared against `meta.version`. */
  version: string;
  /** Every skill, including `disable-model-invocation`, for `/skills`. */
  items: SkillListItem[];
}

export interface SkillsIndexProvider {
  /** False when `settings.skills.enabled` is off (or no options were built). */
  readonly enabled: boolean;
  /**
   * The launch workspace the scan is bound to. Skills do NOT move with a
   * worktree switch (that split is deliberate — see CLAUDE.md), so callers that
   * rebuild `SkillsOptions` must use this, not `ctx.workspace`.
   */
  readonly workspace: string;
  /** The last built snapshot. Cheap: no file-system access. */
  current(): SkillsIndexSnapshot;
  /** Re-scan every root and rebuild the snapshot. */
  refresh(): SkillsIndexSnapshot;
  /** All scanned skills, including model-disabled ones. */
  list(): SkillListItem[];
}

export interface SkillsIndexProviderOptions {
  settings: Settings;
  /** Launch workspace. Skills stay bound to it across a worktree switch. */
  workspace: string;
  plugins?: readonly LoadedPlugin[];
  logger?: Logger;
}

const DISABLED: SkillsIndexSnapshot = {
  text: "",
  changedText: "",
  version: "disabled",
  items: [],
};

export function createSkillsIndexProvider(opts: SkillsIndexProviderOptions): SkillsIndexProvider {
  const skillsOpts: SkillsOptions | undefined = createSkillsOptions({
    settings: opts.settings,
    workspace: opts.workspace,
    ...(opts.plugins ? { plugins: opts.plugins } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const build = (): SkillsIndexSnapshot => {
    if (!skillsOpts) return DISABLED;
    const items = getSkillList(skillsOpts);
    // `disable-model-invocation` keeps a skill out of the MODEL-facing index
    // only; it remains visible in `/skills` and reachable via its `/{name}`
    // slash command.
    const modelItems = items.filter((s) => !s.disableModelInvocation);
    const rendered = renderSkillsMessage(modelItems, {
      budgetBytes: resolveSkillsIndexBudget(opts.settings, opts.settings.model),
      maxDescriptionBytes: opts.settings.skills.maxDescriptionBytes,
    });
    return { ...rendered, items };
  };

  let snapshot = build();

  return {
    get enabled() {
      return skillsOpts !== undefined;
    },
    workspace: opts.workspace,
    current: () => snapshot,
    refresh: () => {
      // Refresh writes the cache entry every consumer reads (`getSkillList`,
      // `getSkill`), so the index, `/skills` and the slash commands cannot
      // disagree about which skills exist.
      if (skillsOpts) refreshSkills(skillsOpts);
      snapshot = build();
      return snapshot;
    },
    list: () => snapshot.items,
  };
}

interface PreRequestPayload {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  thinkingLevel?: ThinkingLevel;
}

interface PreRequestOverride {
  messages?: MessageParam[];
}

export type SkillsIndexReminderHook = (
  payload: PreRequestPayload,
) => PreRequestOverride | undefined;

interface VisibleSkillsIndex {
  /** `undefined` for a message written before `meta.version` existed. */
  version: string | undefined;
}

/**
 * What the model can still see of the index, read off the view it will actually
 * be sent. Walks backwards and stops at the last compaction boundary — the
 * boundary is the first message of the model view, so anything before it is not
 * visible even though it remains in the append-only history.
 */
function visibleSkillsIndex(messages: MessageParam[]): VisibleSkillsIndex | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (isCompactionMarker(msg)) return undefined;
    if (msg.meta?.kind === "skills-index") return { version: msg.meta.version };
  }
  return undefined;
}

/**
 * Keep the model's view of the skill index current by APPENDING a synthetic
 * user message, never by editing history.
 *
 * The comparison is against the visible history rather than an in-memory
 * "already injected" flag, so the reminder is self-healing across every way the
 * model's window can lose the message while the skill set stays unchanged:
 * compaction moves the slice head past it, `/clear` starts an empty history,
 * `/resume` switches to another one, `/rewind` truncates it. A flag would stay
 * set through all four and leave the model working from a list it can no longer
 * see. It runs inside the CLI's combined `pre_request` injector, so a plan-mode
 * notice or a notification due on the same request is appended alongside it
 * instead of replacing it.
 *
 * Append order (notifications → plan mode → index) only controls the order of
 * the tail messages; the combined injector guarantees this one runs on the same
 * request. It used to be registered last under first-non-undefined-wins, which
 * left the first request of a plan-mode session without any skill index.
 */
export function makeSkillsIndexReminder(provider: SkillsIndexProvider): SkillsIndexReminderHook {
  return ({ messages, tools }) => {
    // The index is worthless without the tool that reads it. Gating on the
    // LIVE tool set (not settings) also covers `permissions.deny`, matching the
    // rule the old system-prompt section enforced via `requires: ["loadSkill"]`.
    if (!tools.some((t) => t.name === "loadSkill")) return undefined;

    const current = provider.current();
    if (current.text === "") return undefined; // skills disabled

    const visible = visibleSkillsIndex(messages);
    if (visible?.version === current.version) return undefined;

    // Do not open a session with an empty index. The transition "had skills →
    // none" still injects, because `visible` exists and the model must learn
    // the old list is gone.
    if (visible === undefined && current.items.length === 0) return undefined;

    const text = visible === undefined ? current.text : current.changedText;
    return {
      messages: [
        ...messages,
        markSynthetic(
          { role: "user", content: [{ type: "text", text }] },
          "skills-index",
          current.version,
        ),
      ],
    };
  };
}

/** Read the payload text out of a skills-index message (tests / diagnostics). */
export function skillsIndexMessageText(message: MessageParam): string {
  return extractText(blocksOf(message));
}
