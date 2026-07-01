import { describe, expect, it } from "vitest";
import { createNovaOAuthProvider, type OAuthStore, type StoredOAuth } from "./oauth.js";

/** An in-memory {@link OAuthStore} for exercising the provider without disk. */
function memStore(initial: StoredOAuth = {}): OAuthStore {
  let state: StoredOAuth = initial;
  return {
    load: () => state,
    save: (s) => {
      state = s;
    },
    clear: () => {
      state = {};
    },
  };
}

describe("NovaOAuthProvider", () => {
  it("advertises a public PKCE client with the configured redirect + scope", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore(),
      scope: "read write",
    });
    const meta = provider.clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://127.0.0.1:7777/callback"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.grant_types).toContain("refresh_token");
    expect(meta.scope).toBe("read write");
    expect(provider.redirectUrl).toBe("http://127.0.0.1:7777/callback");
  });

  it("omits scope when none is configured", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore(),
    });
    expect(provider.clientMetadata.scope).toBeUndefined();
  });

  it("pre-loads persisted tokens and client info from the store", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore({
        tokens: { access_token: "tok", token_type: "Bearer" },
        clientInformation: { client_id: "abc" },
      }),
    });
    expect(provider.tokens()?.access_token).toBe("tok");
    expect(provider.clientInformation()?.client_id).toBe("abc");
  });

  it("generates a fresh CSRF state each call and remembers the latest", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore(),
    });
    const s1 = provider.state();
    const s2 = provider.state();
    expect(s1).not.toBe(s2);
    expect(provider.expectedState).toBe(s2);
  });

  it("records the authorization URL instead of opening a browser", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore(),
    });
    expect(provider.authorizationUrl).toBeUndefined();
    provider.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
    expect(provider.authorizationUrl?.toString()).toBe("https://auth.example/authorize?x=1");
  });

  it("persists tokens, client info, and the PKCE verifier through the store", async () => {
    const store = memStore();
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store,
    });
    await provider.saveClientInformation({ client_id: "cid" });
    await provider.saveCodeVerifier("verifier-123");
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });

    // A fresh provider over the same store reads everything back.
    const reloaded = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store,
    });
    expect(reloaded.clientInformation()?.client_id).toBe("cid");
    expect(reloaded.codeVerifier()).toBe("verifier-123");
    expect(reloaded.tokens()?.access_token).toBe("at");
  });

  it("throws when the PKCE verifier is requested before it was saved", async () => {
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store: memStore(),
    });
    expect(() => provider.codeVerifier()).toThrow(/code verifier/i);
  });

  it("invalidates only the requested credential slice", async () => {
    const store = memStore();
    const provider = await createNovaOAuthProvider({
      clientName: "Nova",
      redirectUrl: "http://127.0.0.1:7777/callback",
      store,
    });
    await provider.saveClientInformation({ client_id: "cid" });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });

    await provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("cid");

    await provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
  });
});
