import { describe, expect, it } from "vitest";
import { GLM_DOCS_URL, describeGlmCode, glmProfile, translateGlmError } from "./glm.js";
import { ProviderError } from "./error.js";

function apiError(
  status: number,
  opts: { code?: number | string; message?: string; retryAfter?: string; nested?: boolean } = {},
): Error & { status: number } {
  const headers = new Headers();
  if (opts.retryAfter !== undefined) headers.set("retry-after", opts.retryAfter);
  const server = {
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.message ? { message: opts.message } : {}),
  };
  return Object.assign(new Error(`${status} boom`), {
    status,
    headers,
    ...(Object.keys(server).length > 0 ? { error: opts.nested ? { error: server } : server } : {}),
  });
}

describe("glmProfile.thinking", () => {
  it("keeps thinking enabled when the endpoint default is selected", () => {
    expect(glmProfile.thinking("auto", "glm-5.3", "openai")).toEqual({
      params: { thinking: { type: "enabled" } },
    });
  });

  it("maps Nova levels onto the three Coding Plan reasoning rungs", () => {
    for (const level of ["off", "low"] as const) {
      expect(glmProfile.thinking(level, "glm-5.3", "openai").params).toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "low",
      });
    }
    for (const level of ["medium", "high"] as const) {
      expect(glmProfile.thinking(level, "glm-5.3", "openai").params).toEqual({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      });
    }
    expect(glmProfile.thinking("max", "glm-5.3", "openai").params).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });
});

describe("describeGlmCode", () => {
  it("covers every documented GLM business code", () => {
    const codes = [
      1000, 1001, 1003, 1005, 1113, 1200, 1210, 1211, 1212, 1213, 1214, 1215, 1220, 1221, 1222,
      1230, 1234, 1261, 1301, 1302, 1305, 1308, 1309, 1310, 1311, 1313, 1314, 1315, 1316, 1317,
      1318, 1319, 1320, 1321,
    ];
    for (const code of codes) expect(describeGlmCode(code)).toBeDefined();
  });

  it("retries only documented transient failures", () => {
    for (const code of [1200, 1230, 1234, 1302, 1305]) {
      expect(describeGlmCode(code)?.retryable).toBe(true);
    }
    for (const code of [1113, 1210, 1261, 1308, 1309, 1310, 1313, 1321]) {
      expect(describeGlmCode(code)?.retryable).toBe(false);
    }
  });

  it("returns undefined for undocumented or missing codes", () => {
    expect(describeGlmCode(9999)).toBeUndefined();
    expect(describeGlmCode(undefined)).toBeUndefined();
  });
});

describe("translateGlmError", () => {
  it("uses the business code before the outer HTTP status", () => {
    const out = translateGlmError(apiError(429, { code: "1309", message: "Coding Plan expired" }));
    expect(out).toBeInstanceOf(ProviderError);
    const error = out as ProviderError;
    expect(error.provider).toBe("glm");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Coding Plan Expired");
    expect(error.message).toContain("business code 1309");
    expect(error.message).toContain("Coding Plan expired");
    expect(error.message).toContain("bigmodel.cn/claude-code");
    expect(error.message).toContain(GLM_DOCS_URL);
  });

  it("reads the nested response-body shape and preserves the original cause", () => {
    const original = apiError(400, {
      code: 1211,
      message: "model does not exist",
      nested: true,
    });
    const error = translateGlmError(original) as ProviderError;
    expect(error.cause).toBe(original);
    expect(error.status).toBe(400);
    expect(error.message).toContain("Model Not Found");
  });

  it("honors retry-after only for retryable business errors", () => {
    const transient = translateGlmError(
      apiError(429, { code: 1302, retryAfter: "7" }),
    ) as ProviderError;
    expect(transient.retryAfterSeconds).toBe(7);
    expect(transient.message).toContain("~7s");

    const permanent = translateGlmError(
      apiError(429, { code: 1308, retryAfter: "7" }),
    ) as ProviderError;
    expect(permanent.retryAfterSeconds).toBeUndefined();
  });

  it("falls back to the HTTP status when the body omits a business code", () => {
    const error = translateGlmError(apiError(500)) as ProviderError;
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it("passes undocumented and status-less errors through", () => {
    expect(translateGlmError(apiError(404))).toBeNull();
    expect(translateGlmError(apiError(429, { code: 9999 }))).toBeNull();
    expect(translateGlmError(new Error("socket hang up"))).toBeNull();
  });

  it("is idempotent", () => {
    const once = translateGlmError(apiError(429, { code: 1302 }));
    expect(translateGlmError(once)).toBe(once);
  });
});

describe("glmProfile.onError", () => {
  it("retries a transient business error with backoff", () => {
    const decision = glmProfile.onError(apiError(429, { code: 1305 }), 2);
    expect(decision).toMatchObject({ retry: true, delayMs: 2_000 });
    expect(decision.error).toBeInstanceOf(ProviderError);
  });

  it("does not retry a permanent HTTP 429 business error", () => {
    const decision = glmProfile.onError(apiError(429, { code: 1309 }), 1);
    expect(decision.retry).toBe(false);
    expect(decision.error).toBeInstanceOf(ProviderError);
  });
});
