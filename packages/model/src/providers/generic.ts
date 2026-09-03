import { DEFAULT_TOKEN_ESTIMATE } from "@nova/base";
import { backoffMs } from "../retry.js";
import { ProviderError, type ProviderErrorInfo } from "./error.js";
import type { ProviderProfile } from "./types.js";

/** HTTP statuses that a generic endpoint can recover from without changing the request. */
function describeRetryableStatus(status: number | undefined): ProviderErrorInfo | undefined {
  if (status === 408) {
    return {
      status,
      title: "Request Timeout",
      cause: "The endpoint timed out while processing the request.",
      remedy: "Retry after a short wait.",
      retryable: true,
    };
  }
  if (status === 409) {
    return {
      status,
      title: "Conflict",
      cause: "The endpoint reported a transient request conflict.",
      remedy: "Retry after a short wait.",
      retryable: true,
    };
  }
  if (status === 429) {
    return {
      status,
      title: "Rate Limit Reached",
      cause: "The endpoint rejected the request because a rate limit was reached.",
      remedy: "Back off and retry, or reduce request frequency.",
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      status,
      title: "Server Error",
      cause: "The endpoint reported a temporary server-side failure.",
      remedy: "Retry after a short wait.",
      retryable: true,
    };
  }
  return undefined;
}

function readStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function readRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  let raw: unknown;
  if (headers instanceof Headers) {
    raw = headers.get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    raw = (headers as Record<string, unknown>)["retry-after"];
  }
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Generic provider profile — first-party Claude and any other endpoint without
 * provider-specific behavior. It maps Nova's semantic reasoning level to the
 * selected protocol's official control: OpenAI Chat Completions uses
 * `reasoning_effort`; Anthropic Messages uses adaptive thinking plus
 * `output_config.effort`. `auto` leaves the endpoint default untouched.
 * It applies no provider-specific error translation, but does retry the common
 * transient HTTP statuses used by OpenAI-compatible SDKs (408, 409, 429, 5xx),
 * honoring `Retry-After` when present. The shared adapter separately retries
 * transient network failures and malformed tool-call JSON.
 *
 * The generic profile's default transport is "anthropic". A compatible
 * endpoint may support only a subset of the official levels. An
 * explicitly selected level is still sent honestly; `auto` is the portable
 * choice when the model's capability is unknown.
 */
export const genericProfile: ProviderProfile = {
  id: "generic",

  // No provider-specific tokenizer known for a generic endpoint; the neutral
  // default (~0.3/char Latin, ~0.6 CJK) is a reasonable approximation.
  tokenEstimate: DEFAULT_TOKEN_ESTIMATE,

  thinking(level, _model, transport) {
    if (level === "auto") return { params: {} };
    if (transport === "openai") {
      return {
        params: { reasoning_effort: level === "off" ? "none" : level },
      };
    }
    if (level === "off") return { params: { thinking: { type: "disabled" } } };
    return {
      params: {
        thinking: { type: "adaptive" },
        output_config: { effort: level },
      },
    };
  },

  onError(err, attempt) {
    const info = describeRetryableStatus(readStatus(err));
    if (!info) return { retry: false, error: err };
    const retryAfterSeconds = readRetryAfter(err);
    const error = new ProviderError("generic", info, {
      cause: err,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
    return {
      retry: true,
      delayMs: backoffMs(attempt, retryAfterSeconds),
      error,
    };
  },
};
