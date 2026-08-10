/**
 * YAML-subset parser for markdown front-matter (`SKILL.md`, slash-command
 * `.md`, sub-agent definitions).
 *
 * The governing contract is **best-effort, never throw**. Front-matter is
 * authored by hand and frequently copied in from other agent runtimes, so a
 * construct we don't model must degrade to "that one key is odd" rather than
 * "the whole file is invalid" — a parser that rejects the document makes the
 * skill/command silently disappear, which is far worse than a mis-typed field.
 * Callers therefore validate the *fields they need* and never treat parsing
 * itself as a failure mode.
 *
 * Supported: nested block mappings and sequences, flow collections
 * (`[a, b]` / `{a: 1}`), single- and double-quoted scalars, block scalars
 * (`|`, `>`, with `-`/`+` chomping), plain multi-line scalar continuation,
 * `#` comments, and YAML core scalar typing (bool / int / float / null).
 *
 * Deliberately unsupported (parsed as opaque strings, not errors): anchors and
 * aliases, tags, explicit `? key` syntax, and multi-document streams.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

/** Matches a leading `---\n … \n---` block; group 1 is the raw front-matter. */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

interface Line {
  /** Count of leading spaces. Tabs are expanded to one space (YAML forbids them for indent). */
  indent: number;
  /** The line with leading indentation stripped. */
  text: string;
  /** The line as written, used verbatim by block scalars. */
  raw: string;
}

function toLines(src: string): Line[] {
  return src.split("\n").map((raw) => {
    const expanded = raw.replace(/^[ \t]+/, (ws) => " ".repeat(ws.length));
    const text = expanded.trimStart();
    return { indent: expanded.length - text.length, text: text.trimEnd(), raw };
  });
}

function isSkippable(line: Line): boolean {
  return line.text === "" || line.text.startsWith("#");
}

/**
 * Split `text` on the first `:` that acts as a key separator — i.e. one at
 * brace/bracket depth 0, outside quotes, followed by whitespace or end-of-line.
 * This is what lets a plain scalar keep its own colons (`description: Use
 * this: for X` → key `description`). Returns null when the line isn't a
 * mapping entry.
 */
function splitKey(text: string): { key: string; rest: string } | null {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === ":" && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        const key = text.slice(0, i).trim();
        if (key === "") return null;
        return { key: unquote(key), rest: text.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(.)/g, (_m, ch: string) => {
        if (ch === "n") return "\n";
        if (ch === "t") return "\t";
        if (ch === "r") return "\r";
        if (ch === "0") return "\0";
        return ch;
      });
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Strip a trailing `# comment` from an unquoted scalar (` #` is the delimiter). */
function stripComment(s: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

const INT_RE = /^[-+]?(0|[1-9]\d*)$/;
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

/** Type a plain (unquoted) scalar per the YAML core schema, leniently. */
function typeScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === "" || s === "~") return null;
  const lower = s.toLowerCase();
  if (lower === "null") return null;
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (FLOAT_RE.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/** Parse a scalar that may be quoted; quoted values are never re-typed. */
function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  return typeScalar(stripComment(s));
}

/**
 * Parse a flow collection (`[…]` / `{…}`). Returns null when `s` isn't a
 * balanced flow collection, so the caller can fall back to a plain scalar
 * rather than losing the value.
 */
function parseFlow(s: string): YamlValue | null {
  const trimmed = s.trim();
  const open = trimmed[0];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  if (!trimmed.endsWith(close)) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return open === "[" ? [] : {};

  const parts = splitFlowParts(inner);
  if (parts === null) return null;
  if (open === "[") return parts.map((p) => parseFlowItem(p));

  const out: Record<string, YamlValue> = {};
  for (const part of parts) {
    const kv = splitKey(part);
    if (kv === null) {
      // A bare entry in a flow mapping — keep it addressable rather than drop it.
      out[unquote(part.trim())] = null;
      continue;
    }
    out[kv.key] = parseFlowItem(kv.rest);
  }
  return out;
}

function parseFlowItem(s: string): YamlValue {
  const nested = parseFlow(s);
  return nested !== null ? nested : parseScalar(s);
}

/** Split a flow collection's interior on top-level commas. Null if unbalanced. */
function splitFlowParts(inner: string): string[] | null {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) return null;
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

interface BlockScalarHeader {
  style: "literal" | "folded";
  chomp: "clip" | "strip" | "keep";
  explicitIndent?: number;
}

/** Recognize a `|` / `>` block-scalar header, with optional chomp + indent indicators. */
function blockScalarHeader(rest: string): BlockScalarHeader | null {
  const m = /^([|>])([-+]?)(\d?)([-+]?)\s*(#.*)?$/.exec(rest.trim());
  if (!m) return null;
  const chompChar = m[2] !== "" ? m[2] : m[4];
  const header: BlockScalarHeader = {
    style: m[1] === "|" ? "literal" : "folded",
    chomp: chompChar === "-" ? "strip" : chompChar === "+" ? "keep" : "clip",
  };
  if (m[3] !== undefined && m[3] !== "") header.explicitIndent = Number(m[3]);
  return header;
}

class Cursor {
  private i = 0;
  constructor(private readonly lines: Line[]) {}

  atEnd(): boolean {
    return this.i >= this.lines.length;
  }

  peek(): Line | undefined {
    return this.lines[this.i];
  }

  next(): Line | undefined {
    return this.lines[this.i++];
  }

  /** Advance past blank lines and comments; returns the next meaningful line. */
  skipFiller(): Line | undefined {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i] as Line;
      if (!isSkippable(line)) return line;
      this.i++;
    }
    return undefined;
  }

  /**
   * Consume a block scalar's body. Lines belong to the block while they are
   * blank or indented deeper than `parentIndent`; indentation relative to the
   * block's own base indent is preserved.
   */
  readBlockScalar(parentIndent: number, header: BlockScalarHeader): string {
    const collected: string[] = [];
    let base = header.explicitIndent !== undefined ? parentIndent + header.explicitIndent : -1;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i] as Line;
      const blank = line.text === "";
      if (!blank && line.indent <= parentIndent) break;
      if (!blank && base === -1) base = line.indent;
      collected.push(blank ? "" : line.raw.slice(Math.min(base === -1 ? 0 : base, line.indent)));
      this.i++;
    }
    while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();

    let body: string;
    if (header.style === "literal") {
      body = collected.join("\n");
    } else {
      // Folded: a single newline between two non-empty, equally-indented lines
      // becomes a space; blank lines and more-indented lines keep their breaks.
      let out = "";
      for (let k = 0; k < collected.length; k++) {
        const cur = collected[k] as string;
        if (k === 0) {
          out = cur;
          continue;
        }
        const prev = collected[k - 1] as string;
        const foldable = prev !== "" && cur !== "" && !cur.startsWith(" ") && !prev.startsWith(" ");
        out += foldable ? ` ${cur}` : `\n${cur}`;
      }
      body = out;
    }
    if (header.chomp === "strip") return body.replace(/\n+$/, "");
    if (header.chomp === "keep") return `${body}\n`;
    return body === "" ? "" : `${body}\n`;
  }

  /** Rewrite the current line in place — used to re-enter a `- ` item as a mapping. */
  replaceCurrent(line: Line): void {
    this.lines[this.i] = line;
  }
}

/** Parse a block mapping whose keys sit at exactly `indent`. */
function parseMapping(cur: Cursor, indent: number): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  for (;;) {
    const line = cur.skipFiller();
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      // Over-indented stray line: skip it rather than abandoning the document.
      cur.next();
      continue;
    }
    if (isSequenceItem(line.text)) break;
    const kv = splitKey(line.text);
    if (kv === null) {
      cur.next();
      continue;
    }
    cur.next();
    out[kv.key] = parseValue(cur, indent, kv.rest);
  }
  return out;
}

/** Parse a block sequence whose `-` markers sit at exactly `indent`. */
function parseSequence(cur: Cursor, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  for (;;) {
    const line = cur.skipFiller();
    if (line === undefined || line.indent < indent) break;
    if (!isSequenceItem(line.text)) break;
    if (line.indent > indent) {
      cur.next();
      continue;
    }
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    // `- key: value` opens a mapping whose first key is on the dash line. Rewrite
    // the line as that key at the item's column so parseMapping can own it.
    if (rest !== "" && splitKey(rest) !== null && parseFlow(rest) === null) {
      const itemIndent = indent + 2;
      cur.replaceCurrent({ indent: itemIndent, text: rest, raw: " ".repeat(itemIndent) + rest });
      out.push(parseMapping(cur, itemIndent));
      continue;
    }
    cur.next();
    out.push(parseValue(cur, indent, rest));
  }
  return out;
}

/**
 * Resolve the value for an entry whose header line has already been consumed.
 * `inline` is the text after `key:` (or after `- `); when empty the value is a
 * nested block on the following lines.
 */
function parseValue(cur: Cursor, indent: number, inline: string): YamlValue {
  if (inline !== "") {
    const header = blockScalarHeader(inline);
    if (header !== null) return cur.readBlockScalar(indent, header);

    const flow = parseFlow(inline);
    if (flow !== null) return flow;

    // A plain scalar may continue onto following, more-indented lines that are
    // themselves neither keys nor sequence items; YAML folds those with a space.
    if (!inline.startsWith('"') && !inline.startsWith("'")) {
      const parts = [stripComment(inline)];
      for (;;) {
        const line = cur.peek();
        if (
          line === undefined ||
          isSkippable(line) ||
          line.indent <= indent ||
          isSequenceItem(line.text) ||
          splitKey(line.text) !== null
        ) {
          break;
        }
        parts.push(stripComment(line.text));
        cur.next();
      }
      if (parts.length > 1) return parts.join(" ");
    }
    return parseScalar(inline);
  }

  const line = cur.skipFiller();
  if (line === undefined || line.indent <= indent) return null;
  return isSequenceItem(line.text)
    ? parseSequence(cur, line.indent)
    : parseMapping(cur, line.indent);
}

/**
 * Parse a front-matter block's interior into a plain object. Never throws:
 * unparseable lines are skipped, and a document that yields nothing returns
 * `{}`.
 */
export function parseFrontMatter(src: string): Record<string, YamlValue> {
  const cur = new Cursor(toLines(src));
  const first = cur.skipFiller();
  if (first === undefined) return {};
  // Sequences at the top level aren't valid front-matter; treat them as empty.
  if (isSequenceItem(first.text)) return {};
  return parseMapping(cur, first.indent);
}

/**
 * Split a markdown document into its front-matter object and remaining body.
 * `hasFrontMatter` distinguishes "no `---` block" from "an empty one", which
 * callers use to reject files that omit it entirely.
 */
export function splitFrontMatter(text: string): {
  meta: Record<string, YamlValue>;
  body: string;
  hasFrontMatter: boolean;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  const m = FRONT_MATTER_RE.exec(normalized);
  if (!m) return { meta: {}, body: normalized, hasFrontMatter: false };
  return {
    meta: parseFrontMatter(m[1] ?? ""),
    body: normalized.slice(m[0].length),
    hasFrontMatter: true,
  };
}

/**
 * Coerce a front-matter value to display text. Scalars stringify (so
 * `description: 2024` survives as `"2024"`); collections yield undefined
 * because flattening them would invent content.
 */
export function frontMatterText(value: YamlValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Coerce a front-matter value to a boolean, falling back to `dflt`. Accepts
 * real booleans plus the string spellings authors reach for, since a hand-
 * written `disable-model-invocation: "true"` should not silently mean `false`.
 */
export function frontMatterBool(value: YamlValue | undefined, dflt: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "no" || s === "off") return false;
  }
  return dflt;
}

/**
 * Coerce a front-matter value to a string list. Accepts a real sequence, a
 * flow list, or a single scalar (promoted to a one-element list).
 */
export function frontMatterList(value: YamlValue | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => frontMatterText(v)).filter((v): v is string => v !== undefined);
  }
  const single = frontMatterText(value);
  return single === undefined ? undefined : [single];
}
