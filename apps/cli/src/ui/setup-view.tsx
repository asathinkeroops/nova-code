import React from "react";
import { Box, Text } from "ink";

export interface SetupEntry {
  kind: "ok" | "err";
  text: string;
}

export interface SetupState {
  header: {
    configPath: string;
    missingCount: number;
    noteBaseURL: boolean;
  };
  entries: SetupEntry[];
  currentPrompt: { label: string; hint: string } | null;
}

export function SetupView({ state }: { state: SetupState }): React.ReactElement {
  const { header, entries, currentPrompt } = state;
  const plural = header.missingCount === 1 ? "" : "s";

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text bold color="cyan">
          Welcome to Nova!
        </Text>
      </Box>
      <Text dimColor>
        {`Missing ${header.missingCount} setting${plural} — let's configure them. (Ctrl+C to abort)`}
      </Text>
      <Text dimColor>{`Config will be saved to: ${header.configPath}`}</Text>
      {header.noteBaseURL ? (
        <Text dimColor>
          Note: baseURL must point to an Anthropic-compatible API endpoint.
        </Text>
      ) : null}

      {entries.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {entries.map((e, i) => (
            <Text key={i} color={e.kind === "ok" ? "green" : "red"}>
              {e.text}
            </Text>
          ))}
        </Box>
      ) : null}

      {currentPrompt ? (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">?</Text> <Text bold>{currentPrompt.label}</Text>{" "}
            <Text dimColor>{`(${currentPrompt.hint})`}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
