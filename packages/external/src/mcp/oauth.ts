import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * The persisted half of an OAuth session for one remote MCP server: the
 * dynamically-registered client credentials, the issued tokens, and the
 * in-flight PKCE verifier. All three are secrets — the host's store must keep
 * them owner-readable only.
 */
export interface StoredOAuth {
  /** Client credentials (dynamically registered or pre-known), reused across runs. */
  clientInformation?: OAuthClientInformationMixed;
  /** The current access/refresh token pair. */
  tokens?: OAuthTokens;
  /** PKCE verifier saved between the authorize redirect and the token exchange. */
  codeVerifier?: string;
}

/**
 * Durable backing store for a server's {@link StoredOAuth}. Implemented by the
 * host (the CLI persists one JSON file per server under `~/.nova/mcp-auth/`);
 * kept abstract here so this package stays free of filesystem/path policy. Every
 * method may be sync or async — the provider awaits them.
 */
export interface OAuthStore {
  load(): Promise<StoredOAuth | undefined> | StoredOAuth | undefined;
  save(state: StoredOAuth): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface NovaOAuthProviderOptions {
  /** Advertised to the authorization server during dynamic registration. */
  clientName: string;
  /** Loopback URL the authorization server redirects back to. Must be stable
   *  across runs: it is registered once and reused, so it has to match the
   *  address the host later listens on to catch the redirect. */
  redirectUrl: string;
  store: OAuthStore;
  /** Optional space-delimited scopes to request. */
  scope?: string;
}

/**
 * An {@link OAuthClientProvider} for a single remote MCP server, backed by a
 * host-supplied {@link OAuthStore}.
 *
 * It performs no I/O of its own beyond the store: rather than open a browser,
 * {@link redirectToAuthorization} simply records the authorization URL (read it
 * back via {@link authorizationUrl}). The host drives the interactive half —
 * open the browser, run a loopback server on {@link redirectUrl}, capture the
 * `code`, then hand it to the transport's `finishAuth`. Token *refresh* needs no
 * interaction and is handled transparently by the SDK using the stored refresh
 * token, which is the common steady-state path after the first grant.
 *
 * Construct via {@link createNovaOAuthProvider}, which pre-loads the store so the
 * synchronous `tokens()`/`clientInformation()`/`codeVerifier()` reads the SDK
 * relies on never hit disk mid-flight.
 */
export class NovaOAuthProvider implements OAuthClientProvider {
  private state_: StoredOAuth;
  private readonly opts: NovaOAuthProviderOptions;
  private lastState?: string;
  private lastAuthorizationUrl?: URL;

  /** Use {@link createNovaOAuthProvider} — it pre-loads `initial` from the store. */
  constructor(opts: NovaOAuthProviderOptions, initial: StoredOAuth) {
    this.opts = opts;
    this.state_ = initial;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client + PKCE: no client secret to leak from a local CLI.
      token_endpoint_auth_method: "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  /** Fresh CSRF state per authorization; remembered for callback verification. */
  state(): string {
    this.lastState = randomUUID();
    return this.lastState;
  }

  /** The `state` value handed to the most recent authorization request, if any. */
  get expectedState(): string | undefined {
    return this.lastState;
  }

  /** The authorization URL captured by the last {@link redirectToAuthorization}. */
  get authorizationUrl(): URL | undefined {
    return this.lastAuthorizationUrl;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.state_.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.state_ = { ...this.state_, clientInformation: info };
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.state_.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.state_ = { ...this.state_, tokens };
    await this.persist();
  }

  /** Records the URL for the host to open; the redirect itself is host-driven. */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.state_ = { ...this.state_, codeVerifier };
    await this.persist();
  }

  codeVerifier(): string {
    const v = this.state_.codeVerifier;
    if (!v) throw new Error("No PKCE code verifier saved for this OAuth session.");
    return v;
  }

  /**
   * Drop credentials the server has rejected so the next attempt re-acquires
   * them rather than looping on a dead token. `all` also forgets the client
   * registration, forcing a fresh dynamic registration.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all") {
      this.state_ = {};
    } else if (scope === "client") {
      this.state_ = { ...this.state_, clientInformation: undefined };
    } else if (scope === "tokens") {
      this.state_ = { ...this.state_, tokens: undefined };
    } else {
      this.state_ = { ...this.state_, codeVerifier: undefined };
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.opts.store.save(this.state_);
  }
}

/** Build a provider with its persisted state pre-loaded from `opts.store`. */
export async function createNovaOAuthProvider(
  opts: NovaOAuthProviderOptions,
): Promise<NovaOAuthProvider> {
  const initial = (await opts.store.load()) ?? {};
  return new NovaOAuthProvider(opts, initial);
}
