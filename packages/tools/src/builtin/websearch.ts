import { z } from "zod";
import type { ToolHandler } from "@nova/core";

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
      "Which provider to use. 'auto' (default) picks the first one whose API key is set in env: BRAVE_SEARCH_API_KEY → TAVILY_API_KEY → SERPER_API_KEY.",
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

function pickAuto(): { provider: Exclude<Provider, "auto">; key: string } | null {
  const env = process.env;
  if (env.BRAVE_SEARCH_API_KEY) return { provider: "brave", key: env.BRAVE_SEARCH_API_KEY };
  if (env.TAVILY_API_KEY) return { provider: "tavily", key: env.TAVILY_API_KEY };
  if (env.SERPER_API_KEY) return { provider: "serper", key: env.SERPER_API_KEY };
  return null;
}

function keyFor(provider: Exclude<Provider, "auto">): string | undefined {
  switch (provider) {
    case "brave":
      return process.env.BRAVE_SEARCH_API_KEY;
    case "tavily":
      return process.env.TAVILY_API_KEY;
    case "serper":
      return process.env.SERPER_API_KEY;
  }
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

export const websearchTool: ToolHandler = {
  definition: {
    name: "websearch",
    description:
      "Search the public web and return title + url + snippet for the top results. " +
      "Use this to discover URLs when the user asks an open question that needs fresh info, or when you don't already have a specific URL to fetch. " +
      "Requires one of these env vars: BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SERPER_API_KEY (auto-selected in that order). " +
      "Do not use websearch to fetch the content of a known URL — use webfetch for that.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);

    let provider: Exclude<Provider, "auto">;
    let apiKey: string;
    if (input.provider === "auto") {
      const picked = pickAuto();
      if (!picked) {
        return {
          output:
            "websearch failed: no provider configured. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SERPER_API_KEY in env.",
          isError: true,
        };
      }
      provider = picked.provider;
      apiKey = picked.key;
    } else {
      provider = input.provider;
      const k = keyFor(provider);
      if (!k) {
        const envName =
          provider === "brave"
            ? "BRAVE_SEARCH_API_KEY"
            : provider === "tavily"
              ? "TAVILY_API_KEY"
              : "SERPER_API_KEY";
        return { output: `websearch failed: ${envName} is not set`, isError: true };
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
  },
};
