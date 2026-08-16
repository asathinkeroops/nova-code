import { describe, expect, it } from "vitest";
import { backoffMs, isMalformedToolJsonError, isTransientNetworkError } from "./retry.js";

describe("isMalformedToolJsonError", () => {
  it("matches the V8 JSON parse messages the SDK surfaces from a bad tool call", () => {
    // The exact message from the reported failure, plus other common shapes.
    for (const msg of [
      "Expected ',' or '}' after property value in JSON at position 28 (line 1 column 29)",
      "Unexpected end of JSON input",
      "Unexpected token } in JSON at position 5",
      "Expected property name or '}' in JSON at position 1",
    ]) {
      expect(isMalformedToolJsonError(new Error(msg))).toBe(true);
    }
  });

  it("matches when the parse error is wrapped as the cause (SDK AnthropicError shape)", () => {
    const cause = new SyntaxError("Expected ',' or '}' after property value in JSON at position 28");
    const wrapped = new Error("stream failed", { cause });
    expect(isMalformedToolJsonError(wrapped)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isMalformedToolJsonError(new Error("429 boom"))).toBe(false);
    expect(isMalformedToolJsonError(new Error("ECONNRESET"))).toBe(false);
    // A real API error object (carries a status) is not a malformed-JSON hiccup.
    expect(isMalformedToolJsonError(Object.assign(new Error("500 boom"), { status: 500 }))).toBe(
      false,
    );
    expect(isMalformedToolJsonError(undefined)).toBe(false);
    expect(isMalformedToolJsonError("plain string")).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially from the base and clamps at the max", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    // 2^19 · 1s would blow past the ceiling — clamp to maxDelayMs.
    expect(backoffMs(20)).toBe(30_000);
  });

  it("honors a server retry-after over the exponential schedule, still clamped", () => {
    expect(backoffMs(1, 5)).toBe(5_000);
    expect(backoffMs(1, 120)).toBe(30_000);
  });
});

describe("isTransientNetworkError", () => {
  it("matches Node socket errors by their `code`", () => {
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "ERR_STREAM_PREMATURE_CLOSE",
    ]) {
      const err = Object.assign(new Error("boom"), { code, syscall: "read" });
      expect(isTransientNetworkError(err)).toBe(true);
    }
  });

  it("matches the exact reported failure (read ECONNRESET)", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("matches undici/SDK wrappers that nest the socket error as a cause", () => {
    // undici surfaces `TypeError: terminated` with the real code a level down.
    const socket = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const terminated = new Error("terminated", { cause: socket });
    // The Anthropic SDK wraps that again as its "Connection error."
    const apiConn = new Error("Connection error.", { cause: terminated });
    expect(isTransientNetworkError(terminated)).toBe(true);
    expect(isTransientNetworkError(apiConn)).toBe(true);
  });

  it("matches transport failures by message when the code was lost in wrapping", () => {
    for (const msg of [
      "socket hang up",
      "Client network socket disconnected before secure TLS connection was established",
      "fetch failed",
      "Connection error.",
      "Request timed out.",
    ]) {
      expect(isTransientNetworkError(new Error(msg))).toBe(true);
    }
    expect(isTransientNetworkError("read ECONNRESET")).toBe(true);
  });

  it("does not match model/API errors or user aborts", () => {
    expect(isTransientNetworkError(new Error("429 boom"))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isTransientNetworkError(new Error("Unexpected end of JSON input"))).toBe(false);
    expect(isTransientNetworkError(new Error("Request was aborted."))).toBe(false);
    expect(isTransientNetworkError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });

  it("stops walking a self-referential cause chain instead of looping forever", () => {
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransientNetworkError(err)).toBe(false);
  });
});
