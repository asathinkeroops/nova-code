/**
 * Minimal subset of the Language Server Protocol types Nova actually uses.
 * Positions are LSP-native here: zero-based line and character (UTF-16 code
 * units). The tool layer converts to/from one-based line:column for the model.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange?: Range;
}

/** LSP DiagnosticSeverity. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4; // Error | Warning | Information | Hint

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

/** LSP SymbolKind (1..26). We render a small subset of names; rest fall back. */
export type SymbolKind = number;

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

export interface Hover {
  contents: HoverContents;
  range?: Range;
}

export type HoverContents =
  | string
  | { language: string; value: string }
  | { kind: string; value: string }
  | Array<string | { language: string; value: string }>;

/**
 * Definition of one language server: how to launch it and which file
 * extensions (lowercase, no dot) it owns. `languageId` is the LSP
 * `textDocument.languageId` sent on didOpen.
 */
export interface ServerConfig {
  languageId: string;
  command: string;
  args: string[];
  extensions: string[];
}

export interface LspManagerOptions {
  /** Absolute workspace root; becomes each server's rootUri. */
  root: string;
  /** Effective server table (defaults merged with user overrides). */
  servers: ServerConfig[];
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How long to wait for publishDiagnostics after didOpen. */
  diagnosticsTimeoutMs?: number;
  /** Optional structured logger (pino-shaped); errors only if absent. */
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}
