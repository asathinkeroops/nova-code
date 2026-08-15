import { z } from "zod";
import type { ToolHandler } from "@nova/core";

const inputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Absolute http(s) URL to fetch. Only http and https are allowed."),
  format: z
    .enum(["markdown", "text", "html"])
    .default("markdown")
    .describe(
      "Output shape. 'markdown' (default) strips scripts/styles/nav and converts the body to readable markdown-ish text. 'text' returns plain text without link URLs. 'html' returns the raw response body.",
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(2_000_000)
    .default(500_000)
    .describe("Cap on response body bytes (default 500KB). Larger responses are truncated."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(30_000)
    .describe("Network timeout in milliseconds (default 30s)."),
  respect_robots: z
    .boolean()
    .default(true)
    .describe("If true (default), fetch /robots.txt first and refuse paths disallowed for *."),
});

const USER_AGENT = "nova-webfetch/0.1 (+https://github.com/anthropics/nova)";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function getFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("global fetch is unavailable (requires Node 18+)");
  return f;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 1) return live[0]!;
  const ctl = new AbortController();
  const onAbort = (reason: unknown) => ctl.abort(reason);
  for (const s of live) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => onAbort(s.reason), { once: true });
  }
  return ctl.signal;
}

async function readCappedText(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    if (text.length <= maxBytes) return { text, truncated: false };
    return { text: text.slice(0, maxBytes), truncated: true };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const allowed = value.byteLength - (bytes - maxBytes);
        out += decoder.decode(value.subarray(0, Math.max(0, allowed)), { stream: false });
        truncated = true;
        await reader.cancel();
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    if (!truncated) out += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return { text: out, truncated };
}

// --- robots.txt -----------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

function parseRobots(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "disallow") current.disallow.push(val);
    else if (key === "allow") current.allow.push(val);
  }
  return groups;
}

function robotsAllows(body: string, pathname: string, agent: string): { allowed: boolean; rule?: string } {
  const groups = parseRobots(body);
  const ua = agent.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true };
  // Longest-match between matching Allow/Disallow wins. Empty Disallow = allow-all.
  let bestDeny = "";
  let bestAllow = "";
  for (const d of group.disallow) {
    if (d.length === 0) continue;
    if (pathname.startsWith(d) && d.length > bestDeny.length) bestDeny = d;
  }
  for (const a of group.allow) {
    if (a.length === 0) continue;
    if (pathname.startsWith(a) && a.length > bestAllow.length) bestAllow = a;
  }
  if (!bestDeny) return { allowed: true };
  if (bestAllow.length >= bestDeny.length) return { allowed: true };
  return { allowed: false, rule: `Disallow: ${bestDeny}` };
}

async function checkRobots(
  target: URL,
  fetcher: FetchLike,
  timeoutMs: number,
  ctxSignal: AbortSignal | undefined,
): Promise<{ allowed: boolean; rule?: string }> {
  const robotsURL = new URL("/robots.txt", target).toString();
  try {
    const signal = combineSignals([AbortSignal.timeout(timeoutMs), ctxSignal]);
    const r = await fetcher(robotsURL, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "text/plain, */*;q=0.5" },
      signal,
      redirect: "follow",
    });
    if (r.status === 404 || r.status === 410) return { allowed: true };
    if (!r.ok) return { allowed: true };
    const body = await r.text();
    return robotsAllows(body, target.pathname + target.search, USER_AGENT);
  } catch {
    // fetch errors → fail-open per RFC 9309 §2.3.1.3
    return { allowed: true };
  }
}

// --- HTML → markdown-ish --------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (full, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return ENTITY_MAP[body] ?? full;
  });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function htmlToMarkdown(html: string, keepLinks: boolean): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, "");

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, body: string) => {
    const text = decodeEntities(stripTags(body)).trim();
    return `\n\n${"#".repeat(Number(lvl))} ${text}\n\n`;
  });

  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body: string) => `**${body}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body: string) => `*${body}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, body: string) => `\`${decodeEntities(stripTags(body))}\``);
  s = s.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, body: string) => `\n\n\`\`\`\n${decodeEntities(stripTags(body)).trim()}\n\`\`\`\n\n`,
  );

  if (keepLinks) {
    s = s.replace(
      /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_, _q, href: string, body: string) => {
        const text = decodeEntities(stripTags(body)).trim();
        if (!text) return href;
        return `[${text}](${href})`;
      },
    );
  }

  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|li|tr|article|section|ul|ol|table|blockquote|header|footer|main|nav|aside|figure|figcaption)\b[^>]*>/gi, "\n");
  s = s.replace(/<(p|div|tr|article|section|header|footer|main|nav|aside|figure|figcaption)\b[^>]*>/gi, "\n");

  s = stripTags(s);
  s = decodeEntities(s);

  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function extractTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(stripTags(m[1] ?? "")).trim();
  return t || undefined;
}

// --- tool -----------------------------------------------------------------

export const webfetchTool: ToolHandler = {
  definition: {
    name: "webfetch",
    description:
      "Fetch a single http(s) URL and return its body as markdown (default), plain text, or raw HTML. " +
      "Use this to read documentation pages, blog posts, GitHub READMEs, or specific articles whose URL is already known. " +
      "Honors robots.txt (User-agent: *) and times out at 30s by default. " +
      "Do not use it to crawl a site, fetch large binary downloads, or search the web — use websearch to discover URLs first.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      return { output: `webfetch failed: invalid URL`, isError: true };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { output: `webfetch failed: only http(s) URLs are allowed`, isError: true };
    }

    let fetcher: FetchLike;
    try {
      fetcher = getFetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `webfetch failed: ${msg}`, isError: true };
    }

    if (input.respect_robots) {
      const robots = await checkRobots(target, fetcher, input.timeout_ms, ctx.signal);
      if (!robots.allowed) {
        return {
          output: `webfetch refused: blocked by robots.txt (${robots.rule ?? "Disallow"})`,
          isError: true,
        };
      }
    }

    let res: Response;
    try {
      const signal = combineSignals([AbortSignal.timeout(input.timeout_ms), ctx.signal]);
      res = await fetcher(target.toString(), {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-language": "en;q=0.9",
        },
        signal,
        redirect: "follow",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes("aborted") || msg.includes("timeout") ? " (timed out)" : "";
      return { output: `webfetch failed: ${msg}${hint}`, isError: true };
    }

    if (!res.ok) {
      return { output: `webfetch failed: HTTP ${res.status} ${res.statusText} for ${target.toString()}`, isError: true };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = /text\/html|application\/xhtml/i.test(contentType) || contentType === "";

    const { text, truncated } = await readCappedText(res, input.max_bytes);

    let body: string;
    let title: string | undefined;
    if (input.format === "html" || !isHtml) {
      body = text;
    } else if (input.format === "text") {
      title = extractTitle(text);
      body = htmlToMarkdown(text, false);
    } else {
      title = extractTitle(text);
      body = htmlToMarkdown(text, true);
    }

    const header = [
      `# ${target.toString()}`,
      title ? `title: ${title}` : undefined,
      `status: ${res.status} · content-type: ${contentType || "?"}${truncated ? ` · truncated to ${input.max_bytes} bytes` : ""}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { output: `${header}\n\n${body}` };
  },
};
