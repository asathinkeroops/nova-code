import React from "react";
import { Box, Text } from "ink";
import { ACCENT_HEX } from "../colors.js";
import { LOGO, LOGO_ROW_HEX } from "./logo.js";

export interface SetupEntry {
  kind: "ok" | "err";
  text: string;
}

export interface SetupState {
  header: {
    version: string;
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
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box marginTop={1}>
        <Text>
          <Text color={ACCENT_HEX}>{">_"}</Text> Nova Code{" "}
          <Text dimColor>{`(v${header.version})`}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {LOGO.map((line, i) => (
          <Text key={i} color={LOGO_ROW_HEX[i] ?? ACCENT_HEX}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          The coding agent purpose-built for DeepSeek — 95%+ cache hits ·
          OS-sandboxed · tool-complete
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={ACCENT_HEX}>
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
            <Text color={ACCENT_HEX}>?</Text> <Text bold>{currentPrompt.label}</Text>{" "}
            <Text dimColor>{`(${currentPrompt.hint})`}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
