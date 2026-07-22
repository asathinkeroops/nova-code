import { homedir } from "node:os";
import { canonicalizePath, saveSettings, type Settings } from "@nova/runtime";
import { isWithin } from "@nova/safety";
import { dim, PURPLE_HEX } from "./colors.js";
import { t } from "./i18n/index.js";
import { fatalExit, type Screen } from "./screen.js";
import { pickerArrow } from "./ui/picker.js";
import { readCliVersion } from "./version.js";

/**
 * Workspace trust — the startup gate that asks the user to confirm nova may
 * access the folder it was launched in.
 *
 * The trust decision is recorded in the USER-GLOBAL config (`trust.trustedRoots`
 * in `~/.nova/nova.config.json`), never in a project-checked-in file, so a
 * cloned repository can't mark itself trusted. This mirrors Claude Code's
 * `~/.claude.json` trust model. A workspace is trusted when it equals — or is
 * nested under — any recorded root, so trusting a repo root covers its
 * subdirectories. Trust granted for the home directory is held for the session
 * only and never written to disk.
 */

/**
 * True when `workspace` is trusted: the feature is disabled, or the workspace
 * equals / sits under a recorded trusted root. All paths are canonicalized
 * (symlink-resolved) before the containment check so it compares real on-disk
 * locations. Never throws.
 */
export async function isWorkspaceTrusted(
  settings: Settings,
  workspace: string,
): Promise<boolean> {
  if (!settings.trust.enabled) return true;
  const wsCanon = await canonicalizePath(workspace, ".");
  for (const root of settings.trust.trustedRoots) {
    const rootCanon = await canonicalizePath(workspace, root);
    if (isWithin(rootCanon, wsCanon)) return true;
  }
  return false;
}

/**
 * Record `workspace` as trusted: append its canonical path to
 * `settings.trust.trustedRoots` (in place) and persist to the user-global
 * config — except for the home directory, which is trusted for this session
 * only and never written to disk. A no-op when the workspace is already listed.
 */
export async function trustWorkspace(
  settings: Settings,
  workspace: string,
  configPath?: string,
): Promise<void> {
  const wsCanon = await canonicalizePath(workspace, ".");
  const roots = settings.trust.trustedRoots.includes(wsCanon)
    ? settings.trust.trustedRoots
    : [...settings.trust.trustedRoots, wsCanon];
  settings.trust = { ...settings.trust, trustedRoots: roots };

  // Home-directory trust is session-only (matches Claude Code): keep it in the
  // in-memory settings above, but never write it to the config on disk.
  const home = await canonicalizePath(homedir(), ".");
  if (wsCanon === home) return;

  await saveSettings({ trust: settings.trust }, configPath);
}

/**
 * Interactive startup gate. If the workspace is already trusted (or trust is
 * disabled) this returns immediately. Otherwise it commandeers the screen with
 * the {@link TrustView} banner + a Yes/No picker: granting trust persists the
 * folder and continues; declining exits via {@link fatalExit}. `configPath` is
 * forwarded to {@link trustWorkspace} (tests point it at a temp file).
 */
export async function ensureWorkspaceTrust(
  settings: Settings,
  screen: Screen,
  workspace: string,
  configPath?: string,
): Promise<void> {
  if (await isWorkspaceTrusted(settings, workspace)) return;

  const wsCanon = await canonicalizePath(workspace, ".");
  screen.beginTrust({
    version: await readCliVersion(),
    workspace: wsCanon,
    lines: t.trust.lines,
  });

  try {
    const choice = await screen.pickOne<{ trust: boolean }>({
      items: [{ trust: true }, { trust: false }],
      footer: dim(t.trust.footer),
      border: false,
      topRuleColor: PURPLE_HEX,
      render: (it, selected) => {
        const label = it.trust ? t.trust.yes : t.trust.no;
        return `${pickerArrow(selected)} ${label}`;
      },
    });

    if (choice === null || !choice.trust) {
      // fatalExit unmounts + exits; the finally below won't run.
      await fatalExit(screen, t.trust.exiting(wsCanon), 1);
    }

    try {
      await trustWorkspace(settings, workspace, configPath);
    } catch (err) {
      // A failed write shouldn't crash the session — the user already consented,
      // so trust holds for this run; it just won't be remembered next time.
      const msg = err instanceof Error ? err.message : String(err);
      screen.card(t.trust.persistFailed(msg), {
        kind: "warn",
        title: t.trust.persistFailedTitle,
      });
    }
  } finally {
    screen.endTrust();
  }
}
