import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type SlashCommandKind = "builtin" | "user" | "project" | "mcp" | "skill";

export interface SlashCommandSource {
  kind: SlashCommandKind;
  /** Absolute path of the .md file; undefined for builtins. */
  path?: string;
  /** Same-named commands lower in priority that were shadowed by this one. */
  shadowedBy?: Array<{ kind: SlashCommandKind; path: string }>;
}

export interface SlashArgSpec {
  name: string;
  required?: boolean;
  default?: string;
}

export interface SlashRunCtx {
  cwd: string;
  /**
   * Execute a shell command for Claude-Code-style `` !`cmd` `` interpolation in
   * a command body. Injected by the host so execution stays sandbox-confined
   * and this leaf package keeps no dependency on the tool/sandbox layer. When
   * absent, `` !`cmd` `` segments are left verbatim.
   */
  runCommand?: (command: string) => Promise<{ output: string; isError: boolean }>;
}

export type SlashOutcome =
  | { kind: "handled" }
  | { kind: "prompt"; text: string }
  | { kind: "error"; message: string };

export interface SlashCommand {
  /** Bare name without the leading "/". */
  name: string;
  description: string;
  /** Short hint shown next to the name in /help, e.g. "[focus]". */
  argHint?: string;
  source: SlashCommandSource;
  args?: SlashArgSpec[];
  run: (ctx: SlashRunCtx, args: string) => Promise<SlashOutcome> | SlashOutcome;
}

export interface FileCommandRaw {
  name: string;
  description: string;
  argHint?: string;
  args: SlashArgSpec[];
  body: string;
  path: string;
  kind: "user" | "project";
}

export interface SlashParseError {
  path: string;
  message: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Allows Claude-Code-style namespaced names from subdirectories, joined by ":"
// (e.g. `frontend:component` from `frontend/component.md`).
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z0-9_-]+)*$/;

/**
 * Tiny YAML-subset parser for command front-matter. Supports:
 *   key: scalar               (scalars are unquoted strings, "double", 'single', true/false)
 *   key: [a, b, c]            (flow-style arrays of scalars)
 *   key:
 *     - item                  (block-style arrays of scalars or maps)
 *     - { name: x, required: true }
 *
 * Deliberately limited — command metadata is always small and flat.
 */
function parseFrontMatter(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`unrecognized front-matter line: ${line}`);
    }
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      const items: unknown[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const dash = /^\s*-\s*(.*)$/.exec(next);
        if (!dash) break;
        items.push(parseScalarOrInline(dash[1] ?? ""));
        i++;
      }
      out[key] = items;
      continue;
    }
    out[key] = parseScalarOrInline(rest);
    i++;
  }
  return out;
}

function parseScalarOrInline(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return {} as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const pair of splitFlowPairs(inner)) {
      const idx = pair.indexOf(":");
      if (idx < 0) throw new Error(`malformed inline object: ${v}`);
      const k = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      obj[k] = parseScalar(val);
    }
    return obj;
  }
  return parseScalar(v);
}

/**
 * Split a flow-style mapping body on top-level commas. Handles quoted segments
 * so `{ name: x, default: "a,b" }` keeps the comma inside the string.
 */
function splitFlowPairs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseScalar(v: string): unknown {
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`expected string for "${field}", got ${typeof value}`);
  }
  return value;
}

function parseArgsSpec(value: unknown): SlashArgSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`"args" must be an array`);
  return value.map((entry, idx) => {
    if (typeof entry === "string") return { name: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const name = obj["name"];
      if (typeof name !== "string" || name.length === 0) {
        throw new Error(`"args[${idx}].name" must be a non-empty string`);
      }
      const spec: SlashArgSpec = { name };
      if (typeof obj["required"] === "boolean") spec.required = obj["required"];
      if (typeof obj["default"] === "string") spec.default = obj["default"];
      return spec;
    }
    throw new Error(`"args[${idx}]" must be a string or { name, required?, default? }`);
  });
}

/**
 * Parse a single .md command file. Returns null on parse failure (caller logs
 * the error to keep one bad file from blocking the whole load).
 */
export function parseCommandFile(
  path: string,
  text: string,
  kind: "user" | "project",
  defaultName?: string,
): { ok: FileCommandRaw } | { error: string } {
  try {
    let body = text.replace(/\r\n/g, "\n");
    let meta: Record<string, unknown> = {};
    const fm = FRONT_MATTER_RE.exec(body);
    if (fm) {
      meta = parseFrontMatter(fm[1] ?? "");
      body = body.slice(fm[0].length);
    }
    const fallbackName = defaultName ?? basename(path).replace(/\.md$/i, "");
    const name = asString(meta["name"], "name") ?? fallbackName;
    if (!NAME_RE.test(name)) {
      return { error: `invalid command name "${name}" (must match ${NAME_RE})` };
    }
    const description =
      asString(meta["description"], "description") ?? firstNonEmptyLine(body) ?? "";
    // `argument-hint` is the Claude Code spelling; `argHint` is the nova alias.
    const argHint =
      asString(meta["argHint"], "argHint") ?? asString(meta["argument-hint"], "argument-hint");
    const args = parseArgsSpec(meta["args"]);
    return {
      ok: {
        name,
        description,
        ...(argHint !== undefined ? { argHint } : {}),
        args,
        body: body.trimStart(),
        path,
        kind,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return undefined;
}

/**
 * Substitute {{arg}} / {{arg|default}} placeholders in a command body.
 * - `{{args}}` always expands to the raw trailing arg string.
 * - Declared args fill from positional space-split tokens; the last declared
 *   arg absorbs the remainder so quoted strings aren't required.
 * - Unknown placeholders without a default raise — silently injecting
 *   `{{foo}}` into a prompt would mislead the model.
 */
export function expandPlaceholders(
  body: string,
  args: SlashArgSpec[],
  rawArgs: string,
): { ok: string } | { error: string } {
  const values: Record<string, string> = { args: rawArgs.trim() };
  if (args.length > 0) {
    const trimmed = rawArgs.trim();
    const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    for (let i = 0; i < args.length; i++) {
      const spec = args[i];
      if (!spec) continue;
      if (i === args.length - 1 && tokens.length > i) {
        values[spec.name] = tokens.slice(i).join(" ");
      } else if (i < tokens.length) {
        values[spec.name] = tokens[i] as string;
      } else if (spec.default !== undefined) {
        values[spec.name] = spec.default;
      } else if (spec.required) {
        return { error: `missing required arg "${spec.name}"` };
      } else {
        values[spec.name] = "";
      }
    }
  }
  const re = /\{\{\s*([A-Za-z_][\w-]*)\s*(?:\|([^}]*))?\}\}/g;
  let error: string | null = null;
  const expanded = body.replace(re, (match, name: string, fallback?: string) => {
    if (values[name] !== undefined && values[name] !== "") return values[name];
    if (fallback !== undefined) return fallback;
    if (values[name] === "") return "";
    error = `unknown placeholder "{{${name}}}"`;
    return match;
  });
  if (error) return { error };
  return { ok: expanded };
}

/** `$ARGUMENTS` (all args) and `$1`..`$N` (positional) — Claude Code spelling. */
const DOLLAR_RE = /\$(ARGUMENTS|\d+)/g;
/** `` !`cmd` `` shell interpolation. */
const BANG_RE = /!`([^`]+)`/g;
/** `@path` file reference at a word boundary (so emails / `@scope/pkg` are safe). */
const MENTION_RE = /(^|\s)@([^\s]+)/g;
/** Cap embedded file content so a stray `@huge.log` can't blow up the prompt. */
const MAX_EMBED_BYTES = 100_000;

/** Replace matches of a global regex with an async-computed replacement. */
async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  re.lastIndex = 0;
  const hits: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    hits.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  let out = "";
  let last = 0;
  for (const hit of hits) {
    out += input.slice(last, hit.index);
    out += await fn(hit[0], ...hit.slice(1));
    last = hit.index + hit[0].length;
  }
  return out + input.slice(last);
}

/**
 * Expand a command body using Claude-Code-compatible syntax, layered on top of
 * nova's `{{arg}}` placeholders. Applied in order so each stage can feed the
 * next:
 *   1. `{{arg}}` / `{{arg|default}}` — declared positional args + defaults.
 *   2. `$ARGUMENTS` (raw trailing string) and `$1`..`$N` (positional tokens).
 *   3. `@path` — embed a readable file's contents (left verbatim when the path
 *      doesn't resolve to a file, so emails / `@scope/pkg` survive).
 *   4. `` !`cmd` `` — shell interpolation via the host-injected, sandbox-confined
 *      `ctx.runCommand` (left verbatim when no runner is wired).
 */
export async function expandCommandBody(
  body: string,
  args: SlashArgSpec[],
  rawArgs: string,
  ctx: SlashRunCtx,
): Promise<{ ok: string } | { error: string }> {
  const placeheld = expandPlaceholders(body, args, rawArgs);
  if ("error" in placeheld) return placeheld;
  let text = placeheld.ok;

  const trimmed = rawArgs.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  text = text.replace(DOLLAR_RE, (_match, key: string) => {
    if (key === "ARGUMENTS") return trimmed;
    const idx = Number(key) - 1;
    return idx >= 0 && idx < tokens.length ? (tokens[idx] as string) : "";
  });

  text = await replaceAsync(text, MENTION_RE, async (full, lead: string, rel: string) => {
    const abs = resolve(ctx.cwd, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return full;
    let content = await readFile(abs, "utf8").catch(() => null);
    if (content === null) return full;
    let note = "";
    if (Buffer.byteLength(content, "utf8") > MAX_EMBED_BYTES) {
      content = content.slice(0, MAX_EMBED_BYTES);
      note = "\n… (truncated)";
    }
    return `${lead}Contents of ${rel}:\n\`\`\`\n${content}${note}\n\`\`\``;
  });

  const runCommand = ctx.runCommand;
  if (runCommand) {
    text = await replaceAsync(text, BANG_RE, async (_full, command: string) => {
      const { output } = await runCommand(command);
      return output.trim();
    });
  }

  return { ok: text };
}

/**
 * In-memory registry. Builtin commands beat file commands on name collisions,
 * and file commands earlier in scan order beat later ones. Shadowed entries
 * are recorded on the winner's `source.shadowedBy` for /commands diagnostics.
 */
export class SlashRegistry {
  private readonly byName = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): { replaced?: SlashCommand } {
    const existing = this.byName.get(cmd.name);
    if (existing) {
      if (existing.source.kind === "builtin" && cmd.source.kind !== "builtin") {
        existing.source.shadowedBy = [
          ...(existing.source.shadowedBy ?? []),
          { kind: cmd.source.kind, path: cmd.source.path ?? "" },
        ];
        return {};
      }
      if (existing.source.kind !== "builtin" && cmd.source.kind === "builtin") {
        cmd.source.shadowedBy = [
          ...(cmd.source.shadowedBy ?? []),
          { kind: existing.source.kind, path: existing.source.path ?? "" },
        ];
        this.byName.set(cmd.name, cmd);
        return { replaced: existing };
      }
      cmd.source.shadowedBy = [
        ...(cmd.source.shadowedBy ?? []),
        { kind: existing.source.kind, path: existing.source.path ?? "" },
      ];
      return {};
    }
    this.byName.set(cmd.name, cmd);
    return {};
  }

  clearKind(kind: SlashCommandKind): void {
    for (const [name, cmd] of this.byName) {
      if (cmd.source.kind === kind) this.byName.delete(name);
    }
  }

  list(): SlashCommand[] {
    return Array.from(this.byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Remove a command by name (e.g. an MCP prompt whose server logged out). */
  remove(name: string): boolean {
    return this.byName.delete(name);
  }

  /** Parse a typed REPL line into a registered command + raw arg string. */
  resolve(line: string): { cmd: SlashCommand; args: string } | null {
    if (!line.startsWith("/")) return null;
    const rest = line.slice(1);
    const sep = rest.search(/\s/);
    const name = sep < 0 ? rest : rest.slice(0, sep);
    const args = sep < 0 ? "" : rest.slice(sep + 1);
    const cmd = this.byName.get(name);
    if (!cmd) return null;
    return { cmd, args };
  }
}

export interface LoadCommandsOptions {
  cwd: string;
  /**
   * Project-layer subdir names, scanned in order; earlier wins. Defaults to
   * `[".nova/commands", ".claude/commands", ".commands"]` so the nova
   * ecosystem trumps Claude-style configs and the generic fallback.
   */
  projectDirs?: readonly string[];
  /**
   * User-layer absolute (or `~`-prefixed) directories scanned in order;
   * earlier wins. Defaults to `["~/.nova/commands", "~/.claude/commands"]`.
   */
  userPaths?: readonly string[];
  /** Extra directories appended after user-layer entries. */
  extraDirs?: readonly string[];
  home?: string;
}

export interface LoadCommandsResult {
  commands: FileCommandRaw[];
  errors: SlashParseError[];
  scanned: Array<{ kind: "user" | "project"; path: string; found: number }>;
}

const DEFAULT_PROJECT_DIRS = [".nova/commands", ".claude/commands", ".commands"] as const;
const DEFAULT_USER_DIRS = ["~/.nova/commands", "~/.claude/commands"] as const;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

async function dirExists(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => null);
  return !!s && s.isDirectory();
}

/**
 * Recursively collect `.md` files under a commands directory. Subdirectories
 * become Claude-Code-style name segments joined by ":" (e.g. `frontend:component`
 * for `frontend/component.md`). Results are sorted for deterministic shadowing.
 */
async function walkMarkdown(root: string): Promise<Array<{ path: string; relName: string }>> {
  const out: Array<{ path: string; relName: string }> = [];
  const recurse = async (dir: string, prefix: readonly string[]): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      if (e.isDirectory()) {
        await recurse(join(dir, e.name), [...prefix, e.name]);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        const base = e.name.replace(/\.md$/i, "");
        out.push({ path: join(dir, e.name), relName: [...prefix, base].join(":") });
      }
    }
  };
  await recurse(root, []);
  return out;
}

/**
 * Discover and parse all file-backed slash commands. Project layer scanned
 * before user layer; within each layer the configured directory list defines
 * priority. Same-named files later in the order are dropped (with their path
 * recorded so /commands can show what was shadowed by what).
 */
export async function loadFileCommands(opts: LoadCommandsOptions): Promise<LoadCommandsResult> {
  const home = opts.home ?? homedir();
  const projectDirs = opts.projectDirs ?? DEFAULT_PROJECT_DIRS;
  const userPaths = opts.userPaths ?? DEFAULT_USER_DIRS;
  const extra = opts.extraDirs ?? [];

  const targets: Array<{ kind: "user" | "project"; path: string }> = [];
  for (const d of projectDirs) {
    targets.push({ kind: "project", path: resolve(opts.cwd, d) });
  }
  for (const d of userPaths) {
    targets.push({ kind: "user", path: expandHome(d, home) });
  }
  for (const d of extra) {
    targets.push({ kind: "user", path: expandHome(d, home) });
  }

  const errors: SlashParseError[] = [];
  const accepted = new Map<string, FileCommandRaw>();
  const scanned: LoadCommandsResult["scanned"] = [];

  for (const t of targets) {
    if (!(await dirExists(t.path))) {
      scanned.push({ kind: t.kind, path: t.path, found: 0 });
      continue;
    }
    const files = await walkMarkdown(t.path);
    let found = 0;
    for (const { path: file, relName } of files) {
      const text = await readFile(file, "utf8").catch((err: unknown) => {
        errors.push({ path: file, message: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (text === null) continue;
      const parsed = parseCommandFile(file, text, t.kind, relName);
      if ("error" in parsed) {
        errors.push({ path: file, message: parsed.error });
        continue;
      }
      found++;
      if (!accepted.has(parsed.ok.name)) {
        accepted.set(parsed.ok.name, parsed.ok);
      }
    }
    scanned.push({ kind: t.kind, path: t.path, found });
  }

  return { commands: Array.from(accepted.values()), errors, scanned };
}

/**
 * Wrap a parsed file command as a registry entry. The runtime expands
 * placeholders on each call (cheap, and lets `args` carry per-invocation
 * defaults without rebuilding the registry).
 */
export function fileCommandToSlash(raw: FileCommandRaw): SlashCommand {
  return {
    name: raw.name,
    description: raw.description,
    ...(raw.args.length > 0
      ? { argHint: raw.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ") }
      : {}),
    source: { kind: raw.kind, path: raw.path },
    args: raw.args,
    run: async (ctx, args) => {
      const expanded = await expandCommandBody(raw.body, raw.args, args, ctx);
      if ("error" in expanded) {
        return { kind: "error", message: expanded.error };
      }
      return { kind: "prompt", text: expanded.ok };
    },
  };
}
