import React from "react";
import { Box, Text } from "ink";
import { ACCENT_HEX } from "../colors.js";
import { t } from "../i18n/index.js";
import { LOGO, LOGO_ROW_HEX } from "./logo.js";

/**
 * State for the workspace-trust gate's full-screen view. Deliberately separate
 * from {@link SetupView}/`SetupState`: provider setup and workspace trust are
 * different concerns and must not share a shape. The Yes/No choice itself is a
 * `pick` modal rendered below this view by the App shell.
 */
export interface TrustState {
  version: string;
  /** Canonical absolute path of the folder awaiting a trust decision. */
  workspace: string;
  /** Explanation lines shown under the question. */
  lines: string[];
}

/** Full-screen, top-anchored trust prompt with the Nova banner. */
export function TrustView({ state }: { state: TrustState }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box marginTop={1}>
        <Text>
          <Text color={ACCENT_HEX}>{">_"}</Text> Nova Code{" "}
          <Text dimColor>{`(v${state.version})`}</Text>
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
        <Text bold color={ACCENT_HEX}>
          {t.trust.question}
        </Text>
      </Box>
      <Text>{state.workspace}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.lines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
