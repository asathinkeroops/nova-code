import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { execa } from "execa";
import type { CliContext } from "./context.js";
import { bold, dim } from "./colors.js";
import { t } from "./i18n/index.js";
import { readCliPackage } from "./version.js";

/**
 * Non-blocking startup update check for the `nova` CLI, plus the `nova upgrade`
 * installer.
 *
 * With `settings.update.autoInstall` (default on) the check also *installs*:
 * when the registry has a newer version it runs `settings.update.command` in
 * the background, silently (piped stdio — `inherit` would tear through the ink
 * TUI). It deliberately does NOT try to make the new code live in the running
 * process: Node already loaded `dist/index.js` into memory, so overwriting it
 * on disk changes nothing until the next launch. The card therefore reports
 * "takes effect next launch", never "restart now".
 *
 * Set `autoInstall: false` for the old notify-only behavior (installation then
 * happens exclusively via `nova upgrade`), or `enabled: false` to silence the
 * whole thing.
 */

/** How long to wait on the npm registry before giving up (ms). */
const FETCH_TIMEOUT_MS = 4000;

/** Where the throttle state lives (last check time + last-seen latest version). */
export const UPDATE_CACHE_PATH = join(homedir(), ".nova", "update-check.json");

const REGISTRY_BASE = "https://registry.npmjs.org";

/** One background auto-install attempt, persisted so a poll never repeats it. */
export interface InstallRecord {
  /** The version the install command was run for. */
  version: string;
  /** Epoch ms of the attempt. */
  at: number;
  /** Whether the install command exited 0. */
  ok: boolean;
}

/** Persisted state gating the reminder (not the fetch — that runs every call). */
export interface UpdateCache {
  /** The latest version seen at the most recent fetch (fallback if a fetch fails). */
  latestVersion: string | null;
  /** Epoch ms of the last time we actually showed a notice — gates re-notifying. */
  lastNotifiedAt: number;
  /** The most recent background auto-install attempt, if any. */
  lastInstall: InstallRecord | null;
}

interface ParsedVersion {
  release: [number, number, number];
  prerelease: string[];
}

/** Parse `x.y.z[-pre.release]` (build metadata and a leading `v` are ignored). */
function parseVersion(raw: string): ParsedVersion | null {
  const cleaned = raw.trim().replace(/^v/, "").split("+", 1)[0] ?? "";
  const [core, ...preParts] = cleaned.split("-");
  const nums = (core ?? "").split(".");
  if (nums.length !== 3) return null;
  const release: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number(nums[i]);
    if (!Number.isInteger(n) || n < 0) return null;
    release[i] = n;
  }
  const prerelease = preParts.length > 0 ? preParts.join("-").split(".").filter(Boolean) : [];
  return { release, prerelease };
}

/** Compare two prerelease identifier lists per semver §11. */
function comparePrerelease(a: string[], b: string[]): number {
  // A version with no prerelease outranks one that has a prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? "";
    const bi = b[i] ?? "";
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return Math.sign(diff);
    } else if (an !== bn) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return an ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  // All shared identifiers equal: the longer set has higher precedence.
  return Math.sign(a.length - b.length);
}

/**
 * Compare two semver strings. Returns 1 if `a > b`, -1 if `a < b`, 0 if equal.
 * Unparseable input sorts as lower than any valid version.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    const diff = pa.release[i]! - pb.release[i]!;
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch the `latest` dist-tag manifest for `pkgName` from the npm registry and
 * return its version. Returns null on any network/parse failure — never throws.
 */
export async function fetchLatestVersion(
  pkgName: string,
  fetchImpl?: FetchLike,
): Promise<string | null> {
  const doFetch = fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!doFetch) return null;
  try {
    const url = `${REGISTRY_BASE}/${pkgName}/latest`;
    const res = await doFetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function parseInstallRecord(value: unknown): InstallRecord | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<InstallRecord>;
  if (typeof rec.version !== "string" || typeof rec.at !== "number") return null;
  return { version: rec.version, at: rec.at, ok: rec.ok === true };
}

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    return {
      latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
      lastNotifiedAt: typeof parsed.lastNotifiedAt === "number" ? parsed.lastNotifiedAt : 0,
      lastInstall: parseInstallRecord(parsed.lastInstall),
    };
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/**
 * Whether enough time has passed since the last notice to show it again. The
 * fetch itself is never throttled — only the reminder is. `now` is injected for
 * testability.
 */
export function shouldNotify(lastNotifiedAt: number, now: number, intervalHours: number): boolean {
  if (lastNotifiedAt <= 0) return true; // never notified — always due
  return now - lastNotifiedAt >= intervalHours * 60 * 60 * 1000;
}

/** Options for {@link checkForUpdate}, all injectable so it can be unit-tested. */
export interface CheckDeps {
  now?: number;
  cachePath?: string;
  fetchImpl?: FetchLike;
  packageName?: string;
  /** Stand-in for {@link runUpgrade} so tests never shell out to a package manager. */
  runInstall?: (
    command: string,
    logger?: Logger,
    opts?: { silent?: boolean },
  ) => Promise<number>;
}

function notify(ctx: CliContext, latest: string): void {
  ctx.screen.card(
    `${bold(`nova ${latest}`)} ${t.update.available} ${dim(t.update.youHave(ctx.version))}\n` +
      t.update.runUpgrade(bold("nova upgrade")),
    { kind: "warn", title: t.update.availableTitle, persist: false },
  );
}

function notifyInstalled(ctx: CliContext, latest: string): void {
  ctx.screen.card(
    `${bold(`nova ${latest}`)} ${t.update.installed} ${dim(t.update.youHave(ctx.version))}\n` +
      t.update.effectiveNextLaunch,
    { kind: "info", title: t.update.installedTitle, persist: false },
  );
}

/**
 * Whether to run the install command for `latest` now. Skips when this exact
 * version already installed successfully (it's just waiting for a relaunch) and
 * backs a failed attempt off by the notify interval so a broken command — a
 * global-install EACCES, say — isn't retried on every hourly poll.
 */
export function shouldAttemptInstall(
  lastInstall: InstallRecord | null,
  latest: string,
  now: number,
  intervalHours: number,
): boolean {
  if (!lastInstall || lastInstall.version !== latest) return true;
  if (lastInstall.ok) return false;
  return now - lastInstall.at >= intervalHours * 60 * 60 * 1000;
}

/**
 * Guards against a second install starting while one is still running — the
 * hourly poll can fire while a slow `npm install -g` is mid-flight.
 */
let installInFlight = false;

/**
 * Update check. Non-blocking and best-effort: bails when disabled, always fetches
 * the freshest published version, and — when `autoInstall` is on — installs a
 * newer version in the background before reporting it (the new code goes live on
 * the next launch, not in this process). Otherwise, or if the install command
 * fails, it shows the plain "run nova upgrade" notice. Either card is throttled
 * by `settings.update.notifyIntervalHours` so a long-lived session isn't nagged
 * every poll. Any failure is swallowed so it can never disrupt the caller.
 */
export async function checkForUpdate(ctx: CliContext, deps: CheckDeps = {}): Promise<void> {
  try {
    if (!ctx.settings.update.enabled) return;
    const cachePath = deps.cachePath ?? UPDATE_CACHE_PATH;
    const now = deps.now ?? Date.now();
    const cache = await readCache(cachePath);

    // Always fetch the freshest version; fall back to the last-seen one if the
    // registry is unreachable so we can still remind from cache.
    const pkgName = deps.packageName ?? (await readCliPackage()).name;
    const fetched = await fetchLatestVersion(pkgName, deps.fetchImpl);
    const latestVersion = fetched ?? cache?.latestVersion ?? null;

    // The interval throttles the *notice*, not the fetch.
    const intervalHours = ctx.settings.update.notifyIntervalHours;
    let lastNotifiedAt = cache?.lastNotifiedAt ?? 0;
    let lastInstall = cache?.lastInstall ?? null;

    if (latestVersion && isNewerVersion(latestVersion, ctx.version)) {
      const wantsInstall = ctx.settings.update.autoInstall;
      let justInstalled = false;

      if (
        wantsInstall &&
        !installInFlight &&
        shouldAttemptInstall(lastInstall, latestVersion, now, intervalHours)
      ) {
        installInFlight = true;
        try {
          const code = await (deps.runInstall ?? runUpgrade)(
            ctx.settings.update.command,
            ctx.logger,
            { silent: true },
          );
          lastInstall = { version: latestVersion, at: now, ok: code === 0 };
          justInstalled = code === 0;
          if (code !== 0) {
            ctx.logger.debug({ code }, "background update install failed");
          }
        } finally {
          installInFlight = false;
        }
      }

      // A version installed on an earlier poll (or run) is still pending a
      // relaunch — keep reporting that rather than the "run nova upgrade" nudge.
      const pending =
        justInstalled || (lastInstall?.ok === true && lastInstall.version === latestVersion);
      // A fresh install is a one-shot event (shouldAttemptInstall won't repeat
      // it for this version), so it always reports — it can't turn into nagging.
      if (justInstalled || shouldNotify(lastNotifiedAt, now, intervalHours)) {
        if (pending) notifyInstalled(ctx, latestVersion);
        else notify(ctx, latestVersion);
        lastNotifiedAt = now;
      }
    }

    await writeCache(cachePath, { latestVersion, lastNotifiedAt, lastInstall });
  } catch (err) {
    ctx.logger.debug({ err }, "update check failed");
  }
}

/**
 * Run the configured install command (e.g. `npm install -g …@latest`),
 * streaming its output to the user. Returns the child's exit code (non-zero on
 * failure). `command` is split on whitespace into argv.
 *
 * Pass `silent` for the background auto-install: output is captured instead of
 * inherited (writing to the real stdout would tear through the ink TUI) and
 * logged at debug level.
 */
export async function runUpgrade(
  command: string,
  logger?: Logger,
  opts: { silent?: boolean } = {},
): Promise<number> {
  const parts = command.trim().split(/\s+/);
  const [bin, ...args] = parts;
  if (!bin) {
    logger?.error("update.command is empty");
    return 1;
  }
  try {
    const result = await execa(bin, args, {
      stdio: opts.silent ? "pipe" : "inherit",
      reject: false,
    });
    if (opts.silent) {
      logger?.debug(
        { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        "background update install finished",
      );
    }
    return result.exitCode ?? 0;
  } catch (err) {
    if (opts.silent) logger?.debug({ err }, "background update install failed to launch");
    else logger?.error({ err }, "upgrade command failed to launch");
    return 1;
  }
}
