import React from "react";
import { Box, Text } from "ink";

const THINKING_PREVIEW_CHARS = 200;

function HeaderLine({ label }: { label: string | undefined }): React.ReactElement {
  return (
    <Text>
      <Text color="magenta">✻</Text>{" "}
      <Text dimColor>thinking{label ? ` · ${label}` : ""}</Text>
    </Text>
  );
}

export interface ThinkingBlockProps {
  thinking: string;
  label?: string;
}

export function ThinkingBlock({ thinking, label }: ThinkingBlockProps): React.ReactElement {
  const trimmed = thinking.replace(/\s+$/u, "");
  if (trimmed.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <HeaderLine label={label} />
      </Box>
    );
  }
  const flat = trimmed.replace(/\s+/g, " ");
  const preview =
    flat.length > THINKING_PREVIEW_CHARS ? `${flat.slice(0, THINKING_PREVIEW_CHARS)}…` : flat;
  return (
    <Box flexDirection="column" marginTop={1}>
      <HeaderLine label={label} />
      <Box>
        <Text dimColor>{"  ⎿  "}</Text>
        <Text dimColor italic>
          {preview}
        </Text>
      </Box>
    </Box>
  );
}

export interface RedactedThinkingBlockProps {
  label?: string;
}

export function RedactedThinkingBlock({
  label,
}: RedactedThinkingBlockProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text>
        <Text color="magenta">✻</Text>{" "}
        <Text dimColor>thinking{label ? ` · ${label}` : ""} (redacted)</Text>
      </Text>
    </Box>
  );
}
