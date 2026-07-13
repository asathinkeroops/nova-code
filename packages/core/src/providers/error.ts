/**
 * The provider-neutral model error. A profile's `onError` translates a raw SDK
 * failure into one of these; the adapter throws it and the UI renders its
 * `.message`. The *shape* is the contract (every field is generic); the *content*
 * — which statuses map to what guidance — is each provider's own business, filled
 * from its error table. Adding a provider is implementing `ProviderProfile` and
 * producing this error; no adapter or public-API edit, no per-provider `instanceof`.
 */

/** A documented request failure translated into actionable, provider-neutral guidance. */
export interface ProviderErrorInfo {
  /** HTTP status, when the failure arrived as an API response (absent otherwise). */
  status?: number;
  /** Short label for the failure, e.g. "Insufficient Balance". */
  title: string;
  /** Why it happened. */
  cause: string;
  /** What the operator should do about it. */
  remedy: string;
  /**
   * Whether retrying the same request unchanged could plausibly succeed. Rate
   * limits and server-side faults are transient; auth/balance/validation failures
   * repeat until the operator fixes something.
   */
  retryable: boolean;
  /** Deep-link to where the remedy is performed, when one exists. */
  actionUrl?: string;
  /** Provider's error-code documentation, when it publishes one. */
  docsUrl?: string;
}

/** Extra context captured off the raw error when the profile translates it. */
export interface ProviderErrorOpts {
  /** The original SDK/transport error, kept for logs. */
  cause?: unknown;
  /** The server's own `error.message`, when the body carried one. */
  detail?: string;
  /** Seconds the server asked us to wait (e.g. a 429 `retry-after`). */
  retryAfterSeconds?: number;
}

/**
 * A translated provider failure. Carries the structured {@link ProviderErrorInfo}
 * so hooks/UI can react to `retryable`/`status`/`actionUrl`, keeps the original
 * SDK error as `cause` so nothing is lost, and renders a formatted `.message` so
 * a caller that only reads `.message` still gets actionable guidance.
 */
export class ProviderError extends Error {
  /** Id of the profile that produced this error (e.g. "deepseek"). */
  readonly provider: string;
  readonly info: ProviderErrorInfo;
  /** HTTP status, mirrored from `info.status` for convenience. */
  readonly status?: number;
  /** Whether an unchanged retry could plausibly succeed, mirrored from `info`. */
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** The server's own error message, when present. */
  readonly detail?: string;

  constructor(provider: string, info: ProviderErrorInfo, opts: ProviderErrorOpts = {}) {
    super(formatProviderError(provider, info, opts), { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.info = info;
    this.retryable = info.retryable;
    if (info.status !== undefined) this.status = info.status;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

function formatProviderError(
  provider: string,
  info: ProviderErrorInfo,
  opts: ProviderErrorOpts,
): string {
  const head =
    info.status !== undefined
      ? `${provider} API ${info.status} — ${info.title}`
      : `${provider} — ${info.title}`;
  const lines = [head, `Cause: ${info.cause}`, `Fix:   ${info.remedy}`];
  if (info.retryable) {
    const wait =
      opts.retryAfterSeconds !== undefined
        ? ` (server asked to wait ~${opts.retryAfterSeconds}s)`
        : "";
    lines.push(`Retryable: yes${wait}`);
  }
  if (info.actionUrl) lines.push(`Link:  ${info.actionUrl}`);
  if (opts.detail) lines.push(`Detail: ${opts.detail}`);
  if (info.docsUrl) lines.push(`Docs:  ${info.docsUrl}`);
  return lines.join("\n");
}
