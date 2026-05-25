import React from "react";
import { Box, Text } from "ink";

const LOGO = [
  "███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ",
  "████╗  ██║██╔═══██╗██║   ██║██╔══██╗",
  "██╔██╗ ██║██║   ██║██║   ██║███████║",
  "██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║",
  "██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║",
  "╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝",
];

const LABEL_WIDTH = 11;

export interface BannerProps {
  version: string;
  model: string;
  cwd: string;
  home?: string;
  sessionId: string;
}

function displayCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

function LabelRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

export function Banner({ version, model, cwd, home, sessionId }: BannerProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>
        <Text color="cyan">{">_"}</Text> Nova Coding Agent <Text dimColor>(v{version})</Text>
      </Text>
      <Text> </Text>
      {LOGO.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <LabelRow label="model:">
        {model}    <Text dimColor>/model to change</Text>
      </LabelRow>
      <LabelRow label="workspace:">{displayCwd(cwd, home)}</LabelRow>
      <LabelRow label="session:">{sessionId}</LabelRow>
    </Box>
  );
}
