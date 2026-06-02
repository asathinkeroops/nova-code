import {
  SandboxManager,
  type NetworkConfig,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxBridge } from "@nova/core";

/** Minimal logger shape (a subset of @nova/runtime's Logger), passed in by the caller. */
export interface SandboxLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface CreateSandboxOptions {
  /** Master switch — `settings.sandbox.enabled`. When false the control is inactive. */
  enabled: boolean;
  /**
   * Canonical absolute roots the sandbox may write to — the workspace plus
   * `permissions.additionalDirectories`, already realpath'd by the caller.
   * These mirror the permission engine's allowed roots so write confinement
   * matches the boundary the agent is already gated against.
   */
  writeRoots: readonly string[];
  /** Extra write paths from `settings.sandbox.filesystem.allowWrite` (e.g. "~/.npm"). */
  extraAllowWrite?: readonly string[];
  /** Deny-write paths even within an allowed root (`settings.sandbox.filesystem.denyWrite`). */
  denyWrite?: readonly string[];
  /** Deny-read paths (`settings.sandbox.filesystem.denyRead`); reads are otherwise open. */
  denyRead?: readonly string[];
  /**
   * Re-allow writes to `.git/config` inside the workspace. The SDK always
   * force-denies `.git/config` (and `.git/hooks`, `.vscode/`, dotfiles, …) even
   * within an allowed root; this flag re-opens only `.git/config`. `.git/hooks`
   * stays blocked. Defaults to false here (SDK default); the CLI passes the
   * `sandbox.filesystem.allowGitConfig` setting, which defaults to true.
   */
  allowGitConfig?: boolean;
  /** Capture violations via the platform log monitor so `annotateOutput` has data. */
  monitorViolations?: boolean;
  logger?: SandboxLogger;
}

export interface SandboxControl {
  /** Bridge to inject into ToolContext, or `undefined` when sandboxing is inactive. */
  bridge: SandboxBridge | undefined;
  /** True when the OS sandbox initialized and is enforcing for this session. */
  active: boolean;
  /** Human-readable reason when inactive (disabled / unsupported / missing deps / init error). */
  reason?: string;
  /** Tear down proxies and monitors started during init. Safe to call when inactive. */
  dispose(): Promise<void>;
}

const NOOP_DISPOSE = async (): Promise<void> => {};

function inactive(reason: string): SandboxControl {
  return { bridge: undefined, active: false, reason, dispose: NOOP_DISPOSE };
}

/**
 * Initialize the OS command sandbox (@anthropic-ai/sandbox-runtime) and return
 * a control handle. Confines filesystem **writes** to `writeRoots` (+ extras and
 * SDK defaults); reads stay open and the network is left UNRESTRICTED — the
 * config omits `network.allowedDomains`, which the SDK reads as "no network
 * restriction" (the macOS profile emits `(allow network*)` and no proxy runs).
 *
 * Never throws: any setup failure (disabled, unsupported platform, missing host
 * deps, init error) yields an inactive control with `bridge: undefined`, so the
 * caller can wire it in unconditionally and the agent simply runs unsandboxed.
 */
export async function createSandbox(opts: CreateSandboxOptions): Promise<SandboxControl> {
  const log = opts.logger;

  if (!opts.enabled) return inactive("disabled");
  if (!SandboxManager.isSupportedPlatform()) return inactive("unsupported platform");

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    return inactive(`missing host dependencies: ${deps.errors.join(", ")}`);
  }

  const allowWrite = [...opts.writeRoots, ...(opts.extraAllowWrite ?? [])];
  const config: SandboxRuntimeConfig = {
    filesystem: {
      allowWrite,
      denyWrite: [...(opts.denyWrite ?? [])],
      denyRead: [...(opts.denyRead ?? [])],
      allowGitConfig: opts.allowGitConfig ?? false,
    },
    // No `allowedDomains` → the SDK applies no network restriction (see above).
    // The public type marks network's domain arrays required, but initialize()
    // only reads network's optional proxy/tls fields, so `{}` is safe at runtime.
    network: {} as NetworkConfig,
  };

  try {
    await SandboxManager.initialize(config, undefined, opts.monitorViolations ?? false);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.warn({ err: reason }, "sandbox init failed; continuing unsandboxed");
    try {
      await SandboxManager.reset();
    } catch {
      /* best-effort cleanup of a partial init */
    }
    return inactive(reason);
  }

  const bridge: SandboxBridge = {
    async wrapCommand(command, signal) {
      try {
        return await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, signal);
      } catch (err) {
        // Fail open: a transient wrap failure must not break the tool. The call
        // already cleared the permission engine upstream, so running it
        // unsandboxed is no worse than the no-sandbox baseline. Surfaced as a
        // warning so it isn't silent.
        log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "sandbox wrap failed; running command unsandboxed",
        );
        return command;
      }
    },
    afterCommand() {
      try {
        SandboxManager.cleanupAfterCommand();
      } catch {
        /* best-effort; dispose() force-cleans at session end */
      }
    },
    annotateOutput(command, output) {
      try {
        return SandboxManager.annotateStderrWithSandboxFailures(command, output);
      } catch {
        return output;
      }
    },
  };

  log?.info({ allowWrite }, "sandbox active (filesystem write-confinement, network open)");
  return {
    bridge,
    active: true,
    dispose: async () => {
      try {
        await SandboxManager.reset();
      } catch (err) {
        log?.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox reset failed");
      }
    },
  };
}
