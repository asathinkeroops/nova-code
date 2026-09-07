import { DEFAULT_TOKEN_ESTIMATE } from "@nova/base";
import type { ThinkingLevel } from "@nova/core";
import { backoffMs } from "../retry.js";
import { ProviderError, type ProviderErrorInfo } from "./error.js";
import type { ProviderProfile } from "./types.js";

// GLM publishes an outer HTTP status plus a more specific business code in the
// response body. The business code must win: many permanent Coding Plan states
// (expired subscription, exhausted quota, wrong key product) all use HTTP 429
// and would otherwise be mistaken for a transient rate limit.
export const GLM_DOCS_URL = "https://docs.bigmodel.cn/cn/api/api-code";

const permanent = (
  status: number,
  title: string,
  cause: string,
  remedy: string,
  actionUrl?: string,
): ProviderErrorInfo => ({
  status,
  title,
  cause,
  remedy,
  retryable: false,
  ...(actionUrl ? { actionUrl } : {}),
});

const transient = (
  status: number,
  title: string,
  cause: string,
  remedy: string,
): ProviderErrorInfo => ({ status, title, cause, remedy, retryable: true });

/** Every business code currently documented by the GLM API. */
const GLM_ERROR_TABLE: Record<number, ProviderErrorInfo> = {
  1000: permanent(
    401,
    "Authentication Failure",
    "GLM could not authenticate the request.",
    "Check the API key and retry.",
  ),
  1001: permanent(
    401,
    "Missing Authentication",
    "The request did not carry an Authentication credential.",
    "Set the GLM Coding Plan API key and retry.",
  ),
  1003: permanent(
    401,
    "Expired Authentication Token",
    "The authentication token has expired.",
    "Generate or obtain a fresh API key, then retry.",
  ),
  1005: permanent(
    401,
    "Two-Factor Authentication Required",
    "The account requires a second authentication step.",
    "Complete two-factor authentication, then retry.",
  ),
  1113: permanent(
    429,
    "Account in Arrears",
    "The GLM account has an unpaid balance.",
    "Top up the account, then retry.",
  ),
  1200: transient(
    500,
    "API Call Failed",
    "GLM failed while processing the API call.",
    "Retry after a short wait.",
  ),
  1210: permanent(
    400,
    "Invalid Parameters",
    "The request contains invalid API parameters.",
    "Correct the request using the GLM API documentation, then retry.",
  ),
  1211: permanent(
    400,
    "Model Not Found",
    "The requested GLM model code does not exist.",
    "Check the configured model id and retry.",
  ),
  1212: permanent(
    400,
    "Unsupported Call Method",
    "The model does not support this API call method.",
    "Use a call method supported by the configured model.",
  ),
  1213: permanent(
    400,
    "Missing Parameter",
    "A required request parameter was not received.",
    "Add the missing parameter and retry.",
  ),
  1214: permanent(
    400,
    "Invalid Parameter",
    "A request parameter has an invalid value.",
    "Correct the parameter using the GLM API documentation, then retry.",
  ),
  1215: permanent(
    400,
    "Conflicting Parameters",
    "Two mutually exclusive parameters were set together.",
    "Remove one of the conflicting parameters and retry.",
  ),
  1220: permanent(
    403,
    "Access Denied",
    "This account is not allowed to access the requested API.",
    "Grant the account access or choose an API included in its plan.",
  ),
  1221: permanent(
    400,
    "API Offline",
    "The requested API has been taken offline.",
    "Switch to a currently supported GLM API.",
  ),
  1222: permanent(
    400,
    "API Not Found",
    "The requested API does not exist.",
    "Check the configured baseURL and API path.",
  ),
  1230: transient(
    500,
    "API Workflow Error",
    "GLM's API workflow failed internally.",
    "Retry after a short wait.",
  ),
  1234: transient(
    500,
    "Network Error",
    "GLM reported an internal network error.",
    "Retry after a short wait; contact GLM support if it persists.",
  ),
  1261: permanent(
    400,
    "Prompt Too Long",
    "The prompt exceeds the model's context limit.",
    "Shorten or compact the conversation, then retry.",
  ),
  1301: permanent(
    400,
    "Content Safety Rejection",
    "The input or generated content may contain unsafe or sensitive material.",
    "Revise the prompt to avoid sensitive content, then retry.",
  ),
  1302: transient(
    429,
    "Rate Limit Reached",
    "The account reached its request rate limit.",
    "Reduce request frequency and retry after a short wait.",
  ),
  1305: transient(
    429,
    "Model Overloaded",
    "The selected model is receiving too much traffic.",
    "Retry after a short wait.",
  ),
  1308: permanent(
    429,
    "Usage Limit Reached",
    "The account reached a time-bounded usage limit.",
    "Wait until the reset time reported by GLM, then retry.",
  ),
  1309: permanent(
    429,
    "Coding Plan Expired",
    "The GLM Coding Plan subscription has expired.",
    "Renew the Coding Plan subscription, then retry.",
    "https://bigmodel.cn/claude-code",
  ),
  1310: permanent(
    429,
    "Weekly or Monthly Limit Reached",
    "The account reached its weekly or monthly usage limit.",
    "Wait until the reset time reported by GLM, then retry.",
  ),
  1311: permanent(
    429,
    "Model Not Included in Plan",
    "The current subscription does not include the requested model.",
    "Choose a model included in the plan or upgrade the subscription.",
  ),
  1313: permanent(
    429,
    "Fair-Use Restriction",
    "The account is rate-restricted by the Coding Plan fair-use policy.",
    "Request removal of the restriction from the Coding Plan account page.",
  ),
  1314: permanent(
    429,
    "Enterprise Plan Expired",
    "The enterprise subscription has expired.",
    "Contact the enterprise administrator to restore the plan.",
  ),
  1315: permanent(
    429,
    "Wrong API Key Product",
    "This API key is restricted to an enterprise coding-plan product.",
    "Use an API key issued for the selected GLM product.",
  ),
  1316: permanent(
    429,
    "Five-Hour Limit and Insufficient Balance",
    "The five-hour limit was reached and the primary account cannot fund overage.",
    "Wait for the reported reset time or add balance to the primary account.",
  ),
  1317: permanent(
    429,
    "Seven-Day Limit and Insufficient Balance",
    "The seven-day limit was reached and the primary account cannot fund overage.",
    "Wait for the reported reset time or add balance to the primary account.",
  ),
  1318: permanent(
    429,
    "Five-Hour and Subaccount Limits Reached",
    "The five-hour limit and the subaccount monthly spend limit were both reached.",
    "Ask an administrator to raise the subaccount limit or wait for reset.",
  ),
  1319: permanent(
    429,
    "Seven-Day and Subaccount Limits Reached",
    "The seven-day limit and the subaccount monthly spend limit were both reached.",
    "Ask an administrator to raise the subaccount limit or wait for reset.",
  ),
  1320: permanent(
    429,
    "Five-Hour and Enterprise Limits Reached",
    "The five-hour limit and the enterprise monthly spend limit were both reached.",
    "Ask an administrator to raise the enterprise limit or wait for reset.",
  ),
  1321: permanent(
    429,
    "Seven-Day and Enterprise Limits Reached",
    "The seven-day limit and the enterprise monthly spend limit were both reached.",
    "Ask an administrator to raise the enterprise limit or wait for reset.",
  ),
};

/** Look up one documented GLM business error code. */
export function describeGlmCode(code: number | undefined): ProviderErrorInfo | undefined {
  return code === undefined ? undefined : GLM_ERROR_TABLE[code];
}

/** Fallback diagnostics for responses that omit the documented business code. */
function describeGlmStatus(status: number | undefined): ProviderErrorInfo | undefined {
  if (status === 400)
    return permanent(
      status,
      "Bad Request",
      "GLM rejected the request parameters.",
      "Check the server detail and correct the request.",
    );
  if (status === 401)
    return permanent(
      status,
      "Authentication Failure",
      "GLM could not authenticate the request.",
      "Check the API key and retry.",
    );
  if (status === 403)
    return permanent(
      status,
      "Access Denied",
      "The account cannot access the requested API.",
      "Check the account and model permissions.",
    );
  if (status === 429)
    return transient(
      status,
      "Rate Limit Reached",
      "GLM rejected the request because a rate limit was reached.",
      "Back off and retry after a short wait.",
    );
  if (status === 500)
    return transient(
      status,
      "Server Error",
      "GLM encountered an internal server error.",
      "Retry after a short wait.",
    );
  return undefined;
}

function readStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function readServerError(err: unknown): { code?: number; message?: string } {
  if (typeof err !== "object" || err === null) return {};
  const root = err as Record<string, unknown>;
  const containers = [root.error, root.body];
  for (const container of containers) {
    if (typeof container !== "object" || container === null) continue;
    const outer = container as Record<string, unknown>;
    const nested = outer.error;
    const candidates = [nested, outer];
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const value = candidate as Record<string, unknown>;
      const rawCode = value.code;
      const parsed = typeof rawCode === "string" ? Number(rawCode) : rawCode;
      const code = typeof parsed === "number" && Number.isInteger(parsed) ? parsed : undefined;
      const message =
        typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
      if (code !== undefined || message !== undefined) return { code, message };
    }
  }
  return {};
}

function readRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  let raw: unknown;
  if (headers instanceof Headers) raw = headers.get("retry-after");
  else if (typeof headers === "object" && headers !== null)
    raw = (headers as Record<string, unknown>)["retry-after"];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Translate a GLM HTTP/business-code failure into actionable guidance. */
export function translateGlmError(err: unknown): ProviderError | null {
  if (err instanceof ProviderError && err.provider === "glm") return err;
  const server = readServerError(err);
  // A present-but-unknown business code may acquire new permanent semantics in
  // the future. Pass it through raw instead of falling back to a broad 429
  // retry; HTTP-only fallback is reserved for bodies that omit the code.
  const info =
    server.code === undefined ? describeGlmStatus(readStatus(err)) : describeGlmCode(server.code);
  if (!info) return null;
  const retryAfterSeconds = info.retryable ? readRetryAfter(err) : undefined;
  const detail =
    server.code !== undefined
      ? `[business code ${server.code}]${server.message ? ` ${server.message}` : ""}`
      : server.message;
  return new ProviderError(
    "glm",
    { ...info, docsUrl: GLM_DOCS_URL },
    {
      cause: err,
      ...(detail ? { detail } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    },
  );
}

function levelToReasoningEffort(level: ThinkingLevel): "low" | "high" | "max" | undefined {
  if (level === "auto") return undefined;
  if (level === "max") return "max";
  if (level === "medium" || level === "high") return "high";
  // GLM-5.3 cannot disable thinking. Coding Plan documents none/minimal/low as
  // the low rung, so Nova's `off` intent degrades safely to the minimum.
  return "low";
}

/** GLM Coding Plan's OpenAI-compatible provider profile. */
export const glmProfile: ProviderProfile = {
  id: "glm",
  transport: "openai",
  tokenEstimate: DEFAULT_TOKEN_ESTIMATE,

  thinking(level) {
    const effort = levelToReasoningEffort(level);
    return {
      params: {
        // GLM-5.3 and GLM-5.3-Flash reject `disabled`; explicit enabled also
        // makes `/effort off` safe instead of relying on endpoint coercion.
        thinking: { type: "enabled" },
        ...(effort ? { reasoning_effort: effort } : {}),
      },
    };
  },

  onError(err, attempt) {
    const api = translateGlmError(err);
    if (!api) return { retry: false, error: err };
    if (!api.retryable) return { retry: false, error: api };
    return {
      retry: true,
      delayMs: backoffMs(attempt, api.retryAfterSeconds),
      error: api,
    };
  },
};
