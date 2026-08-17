import { z } from "zod";
import type { ToolContext, ToolHandler, ToolRunResult } from "@nova/core";

const providerSchema = z.enum(["auto", "brave", "tavily", "serper"]);

const inputSchema = z.object({
  query: z.string().min(1).max(500).describe("Search query string."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .default(10)
    .describe("Maximum number of results to return (default 10, capped at 20)."),
  provider: providerSchema
    .default("auto")
    .describe(
      "Which provider to use. 'auto' (default) picks the first one whose API key is configured, in order: brave → tavily → serper.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(15_000)
    .describe("Network timeout in milliseconds (default 15s)."),
});

const USER_AGENT = "nova-websearch/0.1";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Provider = z.infer<typeof providerSchema>;
type ConcreteProvider = Exclude<Provider, "auto">;

/** Provider order used by `provider: "auto"`. */
const PROVIDER_ORDER: readonly ConcreteProvider[] = ["brave", "tavily", "serper"];

/** Env var carrying each provider's key — takes precedence over settings. */
const ENV_VAR: Record<ConcreteProvider, string> = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
};

/** Settings key (under `settings.websearch`) carrying each provider's key. */
const SETTING_KEY: Record<ConcreteProvider, string> = {
  brave: "braveApiKey",
  tavily: "tavilyApiKey",
  serper: "serperApiKey",
};

/**
 * Provider API keys from `settings.websearch` (`~/.nova/nova.config.json`).
 * Injected by the CLI. The config file is the stored default; the matching env
 * var overrides it per shell — the same precedence the model `apiKey` uses
 * (`resolveApiKey` in @nova/base), so there is one rule to remember.
 */
export interface WebsearchKeys {
  brave?: string | undefined;
  tavily?: string | undefined;
  serper?: string | undefined;
}

export interface WebsearchOptions {
  keys?: WebsearchKeys | undefined;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function getFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("global fetch is unavailable (requires Node 18+)");
  return f;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 1) return live[0]!;
  const ctl = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

/** A provider's key: its env var first, then `settings.websearch.<x>ApiKey`. */
function keyFor(provider: ConcreteProvider, keys: WebsearchKeys | undefined): string | undefined {
  const fromEnv = process.env[ENV_VAR[provider]]?.trim();
  if (fromEnv) return fromEnv;
  return keys?.[provider]?.trim() || undefined;
}

function pickAuto(
  keys: WebsearchKeys | undefined,
): { provider: ConcreteProvider; key: string } | null {
  for (const provider of PROVIDER_ORDER) {
    const key = keyFor(provider, keys);
    if (key) return { provider, key };
  }
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

async function searchBrave(
  query: string,
  limit: number,
  key: string,
  fetcher: FetchLike,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const r = await fetcher(url, {
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      "x-subscription-token": key,
    },
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`brave returned HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const results = data.web?.results ?? [];
  return results.slice(0, limit).map((x) => ({
    title: stripHtml(x.title ?? ""),
    url: x.url ?? "",
    snippet: stripHtml(x.description ?? ""),
  }));
}

async function searchTavily(
  query: string,
  limit: number,
  key: string,
  fetcher: FetchLike,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const r = await fetcher("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ api_key: key, query, max_results: limit }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`tavily returned HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results = data.results ?? [];
  return results.slice(0, limit).map((x) => ({
    title: x.title ?? "",
    url: x.url ?? "",
    snippet: x.content ?? "",
  }));
}

async function searchSerper(
  query: string,
  limit: number,
  key: string,
  fetcher: FetchLike,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const r = await fetcher("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ q: query, num: limit }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`serper returned HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const results = data.organic ?? [];
  return results.slice(0, limit).map((x) => ({
    title: x.title ?? "",
    url: x.link ?? "",
    snippet: x.snippet ?? "",
  }));
}

function formatResults(provider: string, query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `websearch[${provider}] no results for "${query}"`;
  }
  const lines: string[] = [`websearch[${provider}] ${results.length} result(s) for "${query}":`];
  results.forEach((r, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${r.title || "(no title)"}`);
    if (r.url) lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet.replace(/\s+/g, " ").slice(0, 400)}`);
  });
  return lines.join("\n");
}

async function runWebsearch(
  rawInput: unknown,
  ctx: ToolContext,
  keys: WebsearchKeys | undefined,
): Promise<ToolRunResult> {
  const input = inputSchema.parse(rawInput);

  let provider: ConcreteProvider;
  let apiKey: string;
  if (input.provider === "auto") {
    const picked = pickAuto(keys);
    if (!picked) {
      return {
        output:
          "websearch failed: no provider configured. Set settings.websearch.braveApiKey / tavilyApiKey / serperApiKey in ~/.nova/nova.config.json, or BRAVE_SEARCH_API_KEY / TAVILY_API_KEY / SERPER_API_KEY in env.",
        isError: true,
      };
    }
    provider = picked.provider;
    apiKey = picked.key;
  } else {
    provider = input.provider;
    const k = keyFor(provider, keys);
    if (!k) {
      return {
        output: `websearch failed: no ${provider} API key — set settings.websearch.${SETTING_KEY[provider]} or ${ENV_VAR[provider]}`,
        isError: true,
      };
    }
    apiKey = k;
  }

  let fetcher: FetchLike;
  try {
    fetcher = getFetch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `websearch failed: ${msg}`, isError: true };
  }

  const signal = combineSignals([AbortSignal.timeout(input.timeout_ms), ctx.signal]);

  try {
    let results: SearchResult[];
    switch (provider) {
      case "brave":
        results = await searchBrave(input.query, input.limit, apiKey, fetcher, signal);
        break;
      case "tavily":
        results = await searchTavily(input.query, input.limit, apiKey, fetcher, signal);
        break;
      case "serper":
        results = await searchSerper(input.query, input.limit, apiKey, fetcher, signal);
        break;
    }
    return { output: formatResults(provider, input.query, results) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `websearch failed: ${msg}`, isError: true };
  }
}

/**
 * Build the websearch tool. `options.keys` carries the provider API keys read
 * from `settings.websearch`; each provider's env var overrides its configured
 * key, and either channel alone is enough (see {@link keyFor}).
 */
export function createWebsearchTool(options: WebsearchOptions = {}): ToolHandler {
  const keys = options.keys;
  return {
    definition: {
      name: "websearch",
      description:
        "Search the public web and return title + url + snippet for the top results. " +
        "Use this to discover URLs when the user asks an open question that needs fresh info, or when you don't already have a specific URL to fetch. " +
        "Requires an API key for one of brave / tavily / serper — from settings.websearch (braveApiKey, tavilyApiKey, serperApiKey) or the matching env var (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, SERPER_API_KEY); auto-selected in that order. " +
        "Do not use websearch to fetch the content of a known URL — use webfetch for that.",
      inputSchema,
    },
    run: (rawInput, ctx) => runWebsearch(rawInput, ctx, keys),
  };
}

/** Keyless default instance: resolves provider keys from env only. */
export const websearchTool: ToolHandler = createWebsearchTool();
