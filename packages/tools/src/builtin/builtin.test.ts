import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserRequest, AskUserResponse } from "@nova/core";
import {
  askUserQuestionTool,
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  webfetchTool,
  websearchTool,
  writeTool,
} from "../index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nova-tools-"));
});

describe("writeTool + readTool round-trip", () => {
  it("writes content and reads it back", async () => {
    const writeRes = await writeTool.run(
      { path: "hello.txt", content: "hi\n", create_dirs: true },
      { cwd: dir },
    );
    expect(writeRes.isError).toBeUndefined();
    const readRes = await readTool.run({ path: "hello.txt" }, { cwd: dir });
    expect(readRes.output).toBe("hi\n");
  });

  it("write creates parent directories by default", async () => {
    const res = await writeTool.run(
      { path: "deep/nested/x.txt", content: "x", create_dirs: true },
      { cwd: dir },
    );
    expect(res.isError).toBeUndefined();
    const got = await readFile(join(dir, "deep/nested/x.txt"), "utf8");
    expect(got).toBe("x");
  });
});

describe("bashTool", () => {
  it("runs a simple command and captures output", async () => {
    const r = await bashTool.run(
      { command: "echo hello && echo world", timeout_ms: 5000 },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("hello");
    expect(String(r.output)).toContain("world");
  });

  it("reports nonzero exit as isError", async () => {
    const r = await bashTool.run({ command: "exit 7", timeout_ms: 5000 }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("exit=7");
  });
});

describe("editTool", () => {
  it("replaces a unique occurrence", async () => {
    await writeTool.run(
      { path: "a.txt", content: "alpha\nbeta\ngamma\n", create_dirs: true },
      { cwd: dir },
    );
    const r = await editTool.run(
      { path: "a.txt", old_string: "beta", new_string: "BETA" },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    const got = await readFile(join(dir, "a.txt"), "utf8");
    expect(got).toBe("alpha\nBETA\ngamma\n");
  });

  it("fails when old_string is ambiguous and replace_all is false", async () => {
    await writeTool.run(
      { path: "a.txt", content: "x\nx\n", create_dirs: true },
      { cwd: dir },
    );
    const r = await editTool.run(
      { path: "a.txt", old_string: "x", new_string: "y" },
      { cwd: dir },
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("occurs 2 times");
  });

  it("replaces every occurrence when replace_all is true", async () => {
    await writeTool.run(
      { path: "a.txt", content: "x\nx\nx\n", create_dirs: true },
      { cwd: dir },
    );
    const r = await editTool.run(
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    const got = await readFile(join(dir, "a.txt"), "utf8");
    expect(got).toBe("y\ny\ny\n");
  });

  it("fails when old_string is not found", async () => {
    await writeTool.run(
      { path: "a.txt", content: "hello\n", create_dirs: true },
      { cwd: dir },
    );
    const r = await editTool.run(
      { path: "a.txt", old_string: "missing", new_string: "x" },
      { cwd: dir },
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("not found");
  });

  it("rejects identical old_string and new_string", async () => {
    await writeTool.run(
      { path: "a.txt", content: "same\n", create_dirs: true },
      { cwd: dir },
    );
    const r = await editTool.run(
      { path: "a.txt", old_string: "same", new_string: "same" },
      { cwd: dir },
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("identical");
  });
});

describe("globTool", () => {
  it("returns relative file paths matching the pattern", async () => {
    await writeFile(join(dir, "a.ts"), "x");
    await writeFile(join(dir, "b.ts"), "x");
    await writeFile(join(dir, "c.md"), "x");
    const r = await globTool.run({ pattern: "*.ts" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    const lines = String(r.output).split("\n");
    expect(lines.some((l) => l === "a.ts")).toBe(true);
    expect(lines.some((l) => l === "b.ts")).toBe(true);
    expect(lines.some((l) => l === "c.md")).toBe(false);
  });

  it("walks nested directories with **", async () => {
    await mkdir(join(dir, "sub/deep"), { recursive: true });
    await writeFile(join(dir, "sub/deep/x.ts"), "x");
    const r = await globTool.run({ pattern: "**/*.ts" }, { cwd: dir });
    expect(String(r.output)).toContain("sub/deep/x.ts");
  });

  it("respects .gitignore", async () => {
    // Make this dir look like its own repo root so the walker stops here.
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".gitignore"), "ignored.ts\n");
    await writeFile(join(dir, "kept.ts"), "x");
    await writeFile(join(dir, "ignored.ts"), "x");
    const r = await globTool.run({ pattern: "*.ts" }, { cwd: dir });
    const out = String(r.output);
    expect(out).toContain("kept.ts");
    expect(out).not.toContain("ignored.ts");
  });

  it("can disable .gitignore filtering", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".gitignore"), "ignored.ts\n");
    await writeFile(join(dir, "ignored.ts"), "x");
    const r = await globTool.run(
      { pattern: "*.ts", respect_gitignore: false },
      { cwd: dir },
    );
    expect(String(r.output)).toContain("ignored.ts");
  });

  it("always skips node_modules and .git contents", async () => {
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules/pkg/x.ts"), "x");
    await writeFile(join(dir, "root.ts"), "x");
    const r = await globTool.run({ pattern: "**/*.ts" }, { cwd: dir });
    const out = String(r.output);
    expect(out).toContain("root.ts");
    expect(out).not.toContain("node_modules");
  });

  it("returns a friendly message when nothing matches", async () => {
    const r = await globTool.run({ pattern: "*.nope" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("no matches");
  });
});

describe("grepTool", () => {
  it("finds matching lines with file and line number", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\nbeta\ngamma\n");
    await writeFile(join(dir, "b.ts"), "delta\nbeta\n");
    const r = await grepTool.run({ pattern: "beta" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    const out = String(r.output);
    expect(out).toMatch(/a\.ts:2:beta/);
    expect(out).toMatch(/b\.ts:2:beta/);
  });

  it("filters by glob", async () => {
    await writeFile(join(dir, "a.ts"), "needle\n");
    await writeFile(join(dir, "a.md"), "needle\n");
    const r = await grepTool.run({ pattern: "needle", glob: "*.ts" }, { cwd: dir });
    const out = String(r.output);
    expect(out).toContain("a.ts");
    expect(out).not.toContain("a.md");
  });

  it("respects case_insensitive", async () => {
    await writeFile(join(dir, "a.ts"), "Needle\n");
    const r = await grepTool.run(
      { pattern: "needle", case_insensitive: true },
      { cwd: dir },
    );
    expect(String(r.output)).toContain("Needle");
  });

  it("returns context lines when before_context/after_context are set", async () => {
    await writeFile(join(dir, "a.ts"), "one\ntwo\nMATCH\nfour\nfive\n");
    const r = await grepTool.run(
      { pattern: "MATCH", before_context: 1, after_context: 1 },
      { cwd: dir },
    );
    const out = String(r.output);
    expect(out).toContain("two");
    expect(out).toContain("MATCH");
    expect(out).toContain("four");
  });

  it("supports files_with_matches", async () => {
    await writeFile(join(dir, "hit.ts"), "needle\n");
    await writeFile(join(dir, "miss.ts"), "nope\n");
    const r = await grepTool.run(
      { pattern: "needle", files_with_matches: true },
      { cwd: dir },
    );
    const out = String(r.output);
    expect(out).toContain("hit.ts");
    expect(out).not.toContain("miss.ts");
  });

  it("returns a friendly message when nothing matches", async () => {
    await writeFile(join(dir, "a.ts"), "hello\n");
    const r = await grepTool.run({ pattern: "absent_token" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("no matches");
  });

  it("reports an error for invalid regex", async () => {
    await writeFile(join(dir, "a.ts"), "x\n");
    const r = await grepTool.run({ pattern: "(unclosed" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("grep failed");
  });
});

describe("askUserQuestionTool", () => {
  const sampleInput = {
    questions: [
      {
        question: "Edge border?",
        header: "Edge",
        options: [
          { label: "Keep" },
          { label: "Drop", description: "lighter look" },
        ],
        multi_select: false,
      },
      {
        question: "Pick features",
        header: "Feats",
        options: [{ label: "A" }, { label: "B" }],
        multi_select: true,
      },
    ],
  };

  it("returns isError when ctx.askUser is missing", async () => {
    const r = await askUserQuestionTool.run(sampleInput, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("unavailable");
  });

  it("formats answers from the askUser callback", async () => {
    const askUser = vi.fn(async (_req: AskUserRequest): Promise<AskUserResponse> => ({
      answers: [{ selected: ["Drop"] }, { selected: ["A", "B"] }],
    }));
    const r = await askUserQuestionTool.run(sampleInput, { cwd: dir, askUser });
    expect(r.isError).toBeUndefined();
    expect(askUser).toHaveBeenCalledOnce();
    expect(String(r.output)).toContain('Q1 "Edge": Drop');
    expect(String(r.output)).toContain('Q2 "Feats": A | B');
  });

  it("includes freeform text when Other is selected", async () => {
    const askUser = vi.fn(async (): Promise<AskUserResponse> => ({
      answers: [{ selected: ["Other"], freeform: "custom border" }, { selected: ["A"] }],
    }));
    const r = await askUserQuestionTool.run(sampleInput, { cwd: dir, askUser });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("Other → custom border");
  });

  it("propagates cancellation as isError", async () => {
    const askUser = vi.fn(async (): Promise<AskUserResponse> => ({
      answers: [],
      cancelled: true,
    }));
    const r = await askUserQuestionTool.run(sampleInput, { cwd: dir, askUser });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("cancelled");
  });

  it("rejects empty questions list via schema", async () => {
    const r = await askUserQuestionTool.run(
      { questions: [] },
      { cwd: dir, askUser: vi.fn() },
    ).catch((e) => ({ output: String(e), isError: true }));
    expect(r.isError).toBe(true);
  });

  it("rejects header longer than 12 chars via schema", async () => {
    const bad = {
      questions: [
        {
          question: "Q",
          header: "this-header-is-too-long",
          options: [{ label: "a" }, { label: "b" }],
          multi_select: false,
        },
      ],
    };
    const r = await askUserQuestionTool
      .run(bad, { cwd: dir, askUser: vi.fn() })
      .catch((e) => ({ output: String(e), isError: true }));
    expect(r.isError).toBe(true);
  });
});

function mkResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

describe("webfetchTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns markdown for a fetched HTML page (with title, headings, links)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return mkResponse(
        "<html><head><title>Hello World</title></head><body><h1>Heading</h1><p>This is <a href=\"https://example.com/x\">a link</a>.</p><script>alert(1)</script></body></html>",
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await webfetchTool.run(
      { url: "https://example.com/page", respect_robots: true },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    const out = String(r.output);
    expect(out).toContain("title: Hello World");
    expect(out).toContain("# Heading");
    expect(out).toContain("[a link](https://example.com/x)");
    expect(out).not.toContain("alert(1)");
  });

  it("refuses URLs disallowed by robots.txt", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return mkResponse("<html><body>nope</body></html>");
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await webfetchTool.run({ url: "https://example.com/private/page" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("robots.txt");
    // page itself should not have been requested
    const urls = fetcher.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/private/page"))).toBe(false);
  });

  it("can be told to skip robots.txt entirely", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) throw new Error("should not be called");
      return mkResponse("<html><body>ok</body></html>");
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await webfetchTool.run(
      { url: "https://example.com/private/page", respect_robots: false },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("ok");
  });

  it("reports non-2xx responses as isError", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("nope", { status: 500, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await webfetchTool.run({ url: "https://example.com/x" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("HTTP 500");
  });

  it("rejects non-http(s) URLs", async () => {
    const r = await webfetchTool.run({ url: "ftp://example.com/x" }, { cwd: dir }).catch((e) => ({
      output: String(e),
      isError: true,
    }));
    expect(r.isError).toBe(true);
  });

  it("returns raw HTML when format=html", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return mkResponse("<html><body><b>x</b></body></html>");
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await webfetchTool.run(
      { url: "https://example.com/x", format: "html" },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("<b>x</b>");
  });
});

describe("websearchTool", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  beforeEach(() => {
    ORIGINAL_ENV.BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
    ORIGINAL_ENV.TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    ORIGINAL_ENV.SERPER_API_KEY = process.env.SERPER_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(ORIGINAL_ENV)) {
      const v = ORIGINAL_ENV[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reports an error when no provider key is configured", async () => {
    const r = await websearchTool.run({ query: "test" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("no provider configured");
  });

  it("maps Brave Search results", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "k";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("api.search.brave.com");
      expect((init?.headers as Record<string, string>)["x-subscription-token"]).toBe("k");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "First", url: "https://a.example/", description: "snippet one" },
              { title: "Second", url: "https://b.example/", description: "snippet <b>two</b>" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await websearchTool.run({ query: "hello world", limit: 5 }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    const out = String(r.output);
    expect(out).toContain("websearch[brave]");
    expect(out).toContain("1. First");
    expect(out).toContain("https://a.example/");
    expect(out).toContain("snippet one");
    expect(out).toContain("snippet two"); // HTML stripped
  });

  it("maps Tavily results", async () => {
    process.env.TAVILY_API_KEY = "t";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.tavily.com/search");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.api_key).toBe("t");
      expect(body.query).toBe("foo");
      return new Response(
        JSON.stringify({
          results: [{ title: "T1", url: "https://t1/", content: "tav snippet" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await websearchTool.run({ query: "foo", provider: "tavily" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("websearch[tavily]");
    expect(String(r.output)).toContain("https://t1/");
    expect(String(r.output)).toContain("tav snippet");
  });

  it("maps Serper results", async () => {
    process.env.SERPER_API_KEY = "s";
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://google.serper.dev/search");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("s");
      return new Response(
        JSON.stringify({
          organic: [{ title: "S1", link: "https://s1/", snippet: "ser snippet" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await websearchTool.run({ query: "foo", provider: "serper" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("websearch[serper]");
    expect(String(r.output)).toContain("https://s1/");
  });

  it("auto-picks brave when its key is set", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "k";
    process.env.TAVILY_API_KEY = "t"; // both set; brave wins
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toContain("api.search.brave.com");
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const r = await websearchTool.run({ query: "q" }, { cwd: dir });
    expect(r.isError).toBeUndefined();
    expect(String(r.output)).toContain("websearch[brave]");
    expect(String(r.output)).toContain("no results");
  });

  it("reports provider HTTP errors", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "k";
    const fetcher = vi.fn(
      async () => new Response("bad key", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetcher);

    const r = await websearchTool.run({ query: "x" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("HTTP 401");
  });

  it("rejects explicit provider with no key", async () => {
    const r = await websearchTool.run({ query: "x", provider: "tavily" }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain("TAVILY_API_KEY");
  });
});
