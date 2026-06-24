import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import {
  LspUnavailableError,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LspManager,
  type Range,
  type SymbolInformation,
} from "@nova/lsp";

const inputSchema = z
  .object({
    action: z
      .enum([
        "definition",
        "implementation",
        "references",
        "hover",
        "diagnostics",
        "document_symbols",
        "workspace_symbol",
      ])
      .describe(
        "What to query: definition (go to def), implementation (go to the concrete implementation(s) of an " +
          "interface/abstract member), references (find usages), hover (type/doc at a position), " +
          "diagnostics (errors/warnings for a file), document_symbols (outline of a file), " +
          "workspace_symbol (find a symbol by name across the project).",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "File to query (absolute or cwd-relative). Required for every action except workspace_symbol, " +
          "where it is an optional hint to pick which language server answers.",
      ),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line of the symbol. Required for definition, implementation, references, and hover."),
    character: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based column of the symbol. Defaults to 1. Used by definition, implementation, references, hover."),
    symbol: z
      .string()
      .optional()
      .describe("Symbol name to search for. Required for workspace_symbol."),
    include_declaration: z
      .boolean()
      .default(true)
      .describe("For references: include the declaration itself in the results."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const MAX_LOCATIONS = 200;

const SYMBOL_KINDS: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method",
  7: "Property", 8: "Field", 9: "Constructor", 10: "Enum", 11: "Interface",
  12: "Function", 13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key", 21: "Null",
  22: "EnumMember", 23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter",
};

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function createLspTool(manager: LspManager): ToolHandler {
  return {
    definition: {
      name: "lsp",
      description:
        "Query a language server for precise code intelligence: go-to-definition, go-to-implementation, " +
        "find-references, hover (types/docs), diagnostics (errors/warnings), and symbol search. Far more accurate than grep for " +
        "navigation because it understands scopes and types. Positions are 1-based line and column. " +
        "Requires the relevant language server installed on PATH (e.g. typescript-language-server, " +
        "pyright-langserver, gopls, rust-analyzer).",
      inputSchema,
    },
    async run(rawInput, ctx) {
      const input = inputSchema.parse(rawInput);
      try {
        const output = await dispatch(manager, input, ctx.cwd);
        return { output };
      } catch (err) {
        if (err instanceof LspUnavailableError) {
          return { output: err.message, isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `lsp ${input.action} failed: ${msg}`, isError: true };
      }
    },
  };
}

async function dispatch(manager: LspManager, input: Input, cwd: string): Promise<string> {
  switch (input.action) {
    case "definition": {
      const { path, position } = requirePosition(input);
      const locs = await manager.definition(path, position);
      return renderLocations(locs, cwd, `definition of ${path}:${input.line}`);
    }
    case "implementation": {
      const { path, position } = requirePosition(input);
      const locs = await manager.implementation(path, position);
      return renderLocations(locs, cwd, `implementations of ${path}:${input.line}`);
    }
    case "references": {
      const { path, position } = requirePosition(input);
      const locs = await manager.references(path, position, input.include_declaration);
      return renderLocations(locs, cwd, `references to ${path}:${input.line}`);
    }
    case "hover": {
      const { path, position } = requirePosition(input);
      const hover = await manager.hover(path, position);
      return renderHover(hover);
    }
    case "diagnostics": {
      const path = requirePath(input);
      const diags = await manager.diagnostics(path);
      return renderDiagnostics(diags, path);
    }
    case "document_symbols": {
      const path = requirePath(input);
      const syms = await manager.documentSymbols(path);
      return renderDocumentSymbols(syms);
    }
    case "workspace_symbol": {
      if (!input.symbol) throw new Error("workspace_symbol requires a `symbol` to search for.");
      const syms = await manager.workspaceSymbols(input.symbol, input.path);
      return renderWorkspaceSymbols(syms, cwd);
    }
  }
}

function requirePath(input: Input): string {
  if (!input.path) throw new Error(`action "${input.action}" requires a \`path\`.`);
  return input.path;
}

function requirePosition(input: Input): { path: string; position: { line: number; character: number } } {
  const path = requirePath(input);
  if (input.line === undefined) {
    throw new Error(`action "${input.action}" requires \`line\` (1-based).`);
  }
  // Convert 1-based model coords to 0-based LSP coords.
  return {
    path,
    position: { line: input.line - 1, character: (input.character ?? 1) - 1 },
  };
}

function rel(cwd: string, uri: string): string {
  try {
    const abs = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    const r = relative(cwd, abs);
    return r && !r.startsWith("..") ? r : abs;
  } catch {
    return uri;
  }
}

/** LSP position (0-based) → human "line:col" (1-based). */
function pos(range: Range): string {
  return `${range.start.line + 1}:${range.start.character + 1}`;
}

async function renderLocations(locs: Location[], cwd: string, label: string): Promise<string> {
  if (locs.length === 0) return `No ${label.split(" ")[0]} found.`;
  const shown = locs.slice(0, MAX_LOCATIONS);
  // Read each referenced file once to attach the source line.
  const fileCache = new Map<string, string[]>();
  const lines: string[] = [`${locs.length} result(s) for ${label}:`];
  for (const loc of shown) {
    const path = rel(cwd, loc.uri);
    const snippet = await sourceLine(loc, fileCache);
    lines.push(snippet ? `  ${path}:${pos(loc.range)}  ${snippet}` : `  ${path}:${pos(loc.range)}`);
  }
  if (locs.length > shown.length) {
    lines.push(`  …(${locs.length - shown.length} more)`);
  }
  return lines.join("\n");
}

async function sourceLine(loc: Location, cache: Map<string, string[]>): Promise<string | undefined> {
  let abs: string;
  try {
    abs = loc.uri.startsWith("file://") ? fileURLToPath(loc.uri) : loc.uri;
  } catch {
    return undefined;
  }
  let fileLines = cache.get(abs);
  if (!fileLines) {
    try {
      fileLines = (await readFile(abs, "utf8")).split("\n");
    } catch {
      cache.set(abs, []);
      return undefined;
    }
    cache.set(abs, fileLines);
  }
  return fileLines[loc.range.start.line]?.trim();
}

function renderHover(hover: Hover | undefined): string {
  if (!hover) return "No hover information available at that position.";
  const c = hover.contents;
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object" && "value" in v) {
      parts.push(String((v as { value: unknown }).value));
    }
  };
  if (Array.isArray(c)) c.forEach(push);
  else push(c);
  const text = parts.join("\n\n").trim();
  return text.length > 0 ? text : "No hover information available at that position.";
}

function renderDiagnostics(diags: Diagnostic[], path: string): string {
  if (diags.length === 0) return `No diagnostics for ${path}.`;
  const lines = [`${diags.length} diagnostic(s) for ${path}:`];
  for (const d of diags) {
    const sev = SEVERITY[d.severity ?? 1] ?? "error";
    const code = d.code !== undefined ? ` [${d.code}]` : "";
    const src = d.source ? `${d.source}: ` : "";
    lines.push(`  ${pos(d.range)} ${sev}${code}: ${src}${d.message.replace(/\n/g, " ")}`);
  }
  return lines.join("\n");
}

function isDocumentSymbol(s: DocumentSymbol | SymbolInformation): s is DocumentSymbol {
  return "selectionRange" in s;
}

function renderDocumentSymbols(syms: DocumentSymbol[] | SymbolInformation[]): string {
  if (syms.length === 0) return "No symbols found in this file.";
  const lines: string[] = ["Symbols:"];
  if (syms.every(isDocumentSymbol)) {
    const walk = (list: DocumentSymbol[], depth: number): void => {
      for (const s of list) {
        const kind = SYMBOL_KINDS[s.kind] ?? `Kind${s.kind}`;
        const detail = s.detail ? `  ${s.detail}` : "";
        lines.push(`${"  ".repeat(depth + 1)}${kind} ${s.name}  (${pos(s.range)})${detail}`);
        if (s.children?.length) walk(s.children, depth + 1);
      }
    };
    walk(syms, 0);
  } else {
    for (const s of syms as SymbolInformation[]) {
      const kind = SYMBOL_KINDS[s.kind] ?? `Kind${s.kind}`;
      const container = s.containerName ? ` in ${s.containerName}` : "";
      lines.push(`  ${kind} ${s.name}${container}  (${pos(s.location.range)})`);
    }
  }
  return lines.join("\n");
}

function renderWorkspaceSymbols(syms: SymbolInformation[], cwd: string): string {
  if (syms.length === 0) return "No matching workspace symbols.";
  const shown = syms.slice(0, MAX_LOCATIONS);
  const lines = [`${syms.length} symbol(s):`];
  for (const s of shown) {
    const kind = SYMBOL_KINDS[s.kind] ?? `Kind${s.kind}`;
    const container = s.containerName ? ` in ${s.containerName}` : "";
    lines.push(`  ${kind} ${s.name}${container}  ${rel(cwd, s.location.uri)}:${pos(s.location.range)}`);
  }
  if (syms.length > shown.length) lines.push(`  …(${syms.length - shown.length} more)`);
  return lines.join("\n");
}
