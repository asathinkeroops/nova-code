#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Point git at the versioned hooks directory. Runs from `prepare`, so a fresh
 * `pnpm install` arms the AI-native gate before the next commit.
 *
 * An existing custom hooksPath is left alone unless AI_NATIVE_FORCE_HOOKS=1:
 * silently replacing a user's hook setup is worse than a missing gate, and the
 * standard documents the manual command.
 */
try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (!existsSync(join(root, ".githooks", "pre-commit"))) process.exit(0);

  let current = "";
  try {
    current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // No value set yet.
  }

  if (current && current !== ".githooks" && process.env.AI_NATIVE_FORCE_HOOKS !== "1") {
    console.warn(
      `[ai-native] core.hooksPath is "${current}"; leaving it alone. ` +
        "Set AI_NATIVE_FORCE_HOOKS=1 to replace it with .githooks.",
    );
    process.exit(0);
  }

  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
  console.log("[ai-native] pre-commit hook installed (core.hooksPath=.githooks)");
} catch {
  // Not a git worktree: nothing to install.
}
