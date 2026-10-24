import { homedir } from "node:os";
import { join } from "node:path";
import { isSensitiveReadPath, isWithin } from "@nova/safety";

/**
 * Out-of-workspace read policy for `auto` mode.
 *
 * Reads are the most frequent out-of-workspace operation (dependency sources,
 * SDK headers, generated temp files) and their risk is not "what can this
 * modify" but "what enters the model's context". A per-read model classifier is
 * a poor fit — it adds latency to the hottest path and cannot see file contents,
 * while the path itself is the strongest signal. So this is a static allowlist,
 * checked only in `auto` mode:
 *
 *   - listed toolchain / package-manager / temp roots → allow without asking
 *   - anything under a sensitive prefix or with a credential-like name → never
 *     (falls through to the engine / approval prompt, and directory-scoped
 *     session grants cannot cover it — see `isSensitiveReadPath`)
 *   - everything else → the normal ask flow, where "always allow reads in
 *     <dir>" turns N prompts into one per directory
 *
 * `permissions.readOnlyDirectories` is the permanent, explicit version of the
 * same idea for user-chosen trees.
 */
const HOME = homedir();

/**
 * Read-only roots auto mode may read unattended. Keep this conservative:
 * adding a directory here means its contents can enter the model context with
 * no prompt, and `webfetch`/`websearch` are already default-allow, so a secret
 * read here could be exfiltrated in a later step.
 *
 * Temp dirs are listed in both raw and macOS realpath'd form (`/tmp` is a
 * symlink to `/private/tmp`), because the permission gate canonicalizes the
 * target before this check.
 */
export const AUTO_READ_ALLOW_PREFIXES: readonly string[] = [
  // System / toolchain installs. Read-only by construction; home to the SDK
  // headers, man pages and package sources the model routinely inspects.
  "/usr",
  "/opt/homebrew",
  "/opt/local",
  "/Library/Developer",
  "/System/Library",
  "/Applications/Xcode.app",
  // Language runtimes and package-manager stores. Reading dependency sources
  // is the single most common out-of-workspace read; none of these hold
  // credentials (the credential stores under `~/.ssh`, `~/.npmrc`, … are
  // caught by the sensitive-path check below instead).
  join(HOME, ".nvm"),
  join(HOME, ".fnm"),
  join(HOME, ".volta"),
  join(HOME, ".pyenv"),
  join(HOME, ".rbenv"),
  join(HOME, ".rustup"),
  join(HOME, ".cargo/registry"),
  join(HOME, "go/pkg/mod"),
  join(HOME, ".npm/_cacache"),
  join(HOME, ".local/share/pnpm/store"),
  join(HOME, ".m2/repository"),
  join(HOME, ".gradle/caches"),
  // Temp dirs: generated reports, build artifacts, agent-written scratch files.
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

/** Read-family tools the auto-mode allowlist applies to. */
export const AUTO_READ_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep"]);

/**
 * True when `auto` mode may read `path` (already canonical) without asking.
 * Sensitive paths are checked first, so a credential store that happens to sit
 * inside an allowlisted tree (or a lookalike home path) is still prompted.
 */
export function isAutoAllowedReadPath(path: string): boolean {
  if (isSensitiveReadPath(path)) return false;
  return AUTO_READ_ALLOW_PREFIXES.some((prefix) => isWithin(prefix, path));
}
