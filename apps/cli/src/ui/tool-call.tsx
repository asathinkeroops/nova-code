import React, { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ToolResultBlock, ToolUseBlock } from "@nova/core";
import {
  compactBody,
  readExisting,
  renderDiff,
  renderFileContent,
  splitDisplayLines,
} from "./diff.js";

const trim = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const flatten = (s: string): string => s.replace(/\n/g, " ");

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : "",
      )
      .join("");
  }
  return JSON.stringify(content);
}

interface UseView {
  header: ReactNode;
  /** Multi-line ANSI block (diff or file content) shown below the header with one blank row above. */
  body?: string;
}

interface ToolDef {
  use?(input: Record<string, unknown>): UseView;
  result?(
    result: ToolResultBlock,
    input: Record<string, unknown> | undefined,
  ): ReactNode;
}

function ErrLine({ result }: { result: ToolResultBlock }): React.ReactElement {
  return (
    <Text color="red">{`✗ ${flatten(trim(contentToString(result.content), 200))}`}</Text>
  );
}

function OkLine({ text }: { text: string }): React.ReactElement {
  return (
    <Text>
      <Text color="green">✓</Text>
      {text ? (
        <>
          {" "}
          <Text dimColor>{text}</Text>
        </>
      ) : null}
    </Text>
  );
}

function BulletHeader({
  name,
  children,
}: {
  name: string;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <Text>
      <Text color="cyan">▶ {name}</Text>
      {children !== undefined ? <>{"  "}{children}</> : null}
    </Text>
  );
}

const tools: Record<string, ToolDef> = {
  bash: {
    use: (input) => {
      const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
      return {
        header: (
          <BulletHeader name="bash">
            <Text dimColor>{trim(cmd, 200)}</Text>
          </BulletHeader>
        ),
      };
    },
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      const preview = flatten(trim(text, 120));
      return <OkLine text={`${lines} line(s)${preview ? `  ${preview}` : ""}`} />;
    },
  },

  read: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const hasRange =
        typeof input.offset === "number" || typeof input.limit === "number";
      const rangeStr = hasRange
        ? `[${input.offset ?? 0}..${input.limit ? Number(input.offset ?? 0) + Number(input.limit) : ""}]`
        : "";
      return {
        header: (
          <BulletHeader name="read">
            {path}
            {rangeStr ? (
              <>
                {" "}
                <Text dimColor>{rangeStr}</Text>
              </>
            ) : null}
          </BulletHeader>
        ),
      };
    },
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      const text = contentToString(result.content);
      const lines = text.length === 0 ? 0 : text.split("\n").length;
      return <OkLine text={`${lines} line(s) · ${text.length} bytes`} />;
    },
  },

  write: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const content = typeof input.content === "string" ? input.content : "";
      const existing = readExisting(path);
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const verb = existing !== null ? "overwrite" : "write";
      const meta = `(${content.length} bytes · ${lines} line${lines === 1 ? "" : "s"})`;
      const header = (
        <BulletHeader name={verb}>
          {path} <Text dimColor>{meta}</Text>
        </BulletHeader>
      );
      if (content.length === 0 && existing === null) return { header };
      const body =
        existing !== null
          ? renderDiff(existing, content, path)
          : renderFileContent(content, path);
      return { header, body };
    },
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      return <OkLine text={flatten(trim(contentToString(result.content), 200))} />;
    },
  },

  askUserQuestion: {
    use: (input) => {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const headers = qs
        .map((q) =>
          q && typeof q === "object" && "header" in q
            ? String((q as { header: unknown }).header)
            : "",
        )
        .filter((h) => h.length > 0)
        .join(", ");
      return {
        header: (
          <BulletHeader name="ask_user">
            <Text dimColor>{headers || `${qs.length} question(s)`}</Text>
          </BulletHeader>
        ),
      };
    },
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      return <OkLine text={flatten(trim(contentToString(result.content), 200))} />;
    },
  },

  edit: {
    use: (input) => {
      const path = typeof input.path === "string" ? input.path : "?";
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const replaceAll = input.replace_all === true;
      const oldLines = splitDisplayLines(oldStr).length;
      const newLines = splitDisplayLines(newStr).length;
      const meta = `(-${oldLines} +${newLines}${replaceAll ? " · all" : ""})`;
      const header = (
        <BulletHeader name="edit">
          {path} <Text dimColor>{meta}</Text>
        </BulletHeader>
      );
      if (oldStr.length === 0 && newStr.length === 0) return { header };
      return { header, body: renderDiff(oldStr, newStr, path) };
    },
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      return <OkLine text={flatten(trim(contentToString(result.content), 200))} />;
    },
  },

  grep: {
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return <OkLine text="no matches" />;
      if (text === "(no output)") return <OkLine text="no output" />;

      const allLines = text.split("\n").filter((l) => l.length > 0);
      const truncated = allLines[allLines.length - 1]?.startsWith("…(truncated") ?? false;
      const lines = truncated ? allLines.slice(0, -1) : allLines;
      const trunc = truncated ? " (truncated)" : "";

      // match-line mode emits "path:lineNo:content"; files_with_matches mode emits bare paths.
      if (/^[^:]+:\d+:/.test(lines[0] ?? "")) {
        const matches = lines.filter((l) => /^[^:]+:\d+:/.test(l));
        const files = new Set(matches.map((l) => l.split(":", 1)[0]));
        return (
          <OkLine text={`${matches.length} match(es) in ${files.size} file(s)${trunc}`} />
        );
      }
      return <OkLine text={`${lines.length} file(s)${trunc}`} />;
    },
  },

  glob: {
    result: (result) => {
      if (result.is_error) return <ErrLine result={result} />;
      const text = contentToString(result.content);
      if (text.startsWith("(no matches")) return <OkLine text="no matches" />;
      // glob's own first line is a count header like "3 matches under /abs". Strip the path.
      const header = (text.split("\n", 1)[0] ?? "").replace(/\s+under\s+.+$/, "");
      return <OkLine text={header} />;
    },
  },
};

function GenericUseHeader({ use }: { use: ToolUseBlock }): React.ReactElement {
  const compact = JSON.stringify(use.input);
  return (
    <BulletHeader name={use.name}>
      <Text dimColor>{trim(compact)}</Text>
    </BulletHeader>
  );
}

function GenericResult({ result }: { result: ToolResultBlock }): React.ReactElement {
  const preview = flatten(trim(contentToString(result.content)));
  if (result.is_error) return <Text color="red">{`✗ ${preview}`}</Text>;
  return <OkLine text={preview} />;
}

export interface ToolCallProps {
  use: ToolUseBlock;
  result: ToolResultBlock | undefined;
}

/**
 * Renders just the per-tool header (and optional body — e.g. write/edit's
 * diff) without the result row. Shared between the transcript's
 * <ToolCall> and the permission approval popup so previews stay in sync.
 * Pass `headerOnly` to suppress the body (used by the approval popup,
 * which has limited vertical space and doesn't need the full diff).
 */
export function ToolUsePreview({
  use,
  headerOnly = false,
  compact = false,
}: {
  use: ToolUseBlock;
  headerOnly?: boolean;
  /** Collapse multi-line bodies (diffs, file contents) to a short preview — used after the tool finishes so transcripts stay readable. */
  compact?: boolean;
}): React.ReactElement {
  const def = tools[use.name];
  const view: UseView = def?.use
    ? def.use(use.input as Record<string, unknown>)
    : { header: <GenericUseHeader use={use} /> };
  const body = view.body && compact ? compactBody(view.body) : view.body;

  return (
    <Box flexDirection="column">
      {view.header}
      {!headerOnly && body ? (
        <Box marginTop={1}>
          <Text>{body}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ToolCall({ use, result }: ToolCallProps): React.ReactElement {
  const def = tools[use.name];

  return (
    <Box flexDirection="column" marginTop={1}>
      <ToolUsePreview use={use} compact={result !== undefined} />
      <ResultRow>
        {result ? (
          def?.result ? (
            def.result(result, use.input as Record<string, unknown> | undefined)
          ) : (
            <GenericResult result={result} />
          )
        ) : (
          <Text dimColor>…</Text>
        )}
      </ResultRow>
    </Box>
  );
}

function ResultRow({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <Box>
      <Text dimColor>{"  ⎿  "}</Text>
      {children}
    </Box>
  );
}

const BATCH_MAX_VISIBLE = 5;

/**
 * Collapse a run of consecutive same-tool calls (currently just `read`) into a
 * single header + per-entry status list. Caps the visible rows at
 * BATCH_MAX_VISIBLE; everything beyond gets summarised on a `… +N more` row.
 */
export function ReadBatch({
  entries,
}: {
  entries: Array<{ use: ToolUseBlock; result: ToolResultBlock | undefined }>;
}): React.ReactElement {
  const visible = entries.slice(0, BATCH_MAX_VISIBLE);
  const hidden = entries.length - visible.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <BulletHeader name="read">
        <Text>{`${entries.length} file${entries.length === 1 ? "" : "s"}`}</Text>
      </BulletHeader>
      <Box flexDirection="column">
        {visible.map((entry, i) => (
          <BatchRow
            key={entry.use.id}
            entry={entry}
            isFirst={i === 0}
          />
        ))}
        {hidden > 0 ? (
          <Box>
            <Text dimColor>{"     "}</Text>
            <Text dimColor>{`… +${hidden} more`}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function BatchRow({
  entry,
  isFirst,
}: {
  entry: { use: ToolUseBlock; result: ToolResultBlock | undefined };
  isFirst: boolean;
}): React.ReactElement {
  const input = entry.use.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : "?";
  const result = entry.result;
  const mark =
    result === undefined ? (
      <Text dimColor>…</Text>
    ) : result.is_error ? (
      <Text color="red">✗</Text>
    ) : (
      <Text color="green">✓</Text>
    );
  return (
    <Box>
      <Text dimColor>{isFirst ? "  ⎿  " : "     "}</Text>
      {mark}
      <Text>{` ${path}`}</Text>
    </Box>
  );
}
