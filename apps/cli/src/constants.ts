import type { SlashCommand } from "./input.js";

export const WORKING_WORDS = [
  "Thinking...",
  "Pondering...",
  "Churning...",
  "Crunching...",
  "Cooking...",
  "Brewing...",
  "Hatching...",
  "Mulling...",
  "Computing...",
  "Reasoning...",
  "Synthesizing...",
  "Cogitating...",
  "Deliberating...",
  "Working...",
  "Hustling...",
  "Tinkering...",
  "Plotting...",
  "Scheming...",
];

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "show this help" },
  { name: "/model", description: "show or change the active model" },
  { name: "/think", description: "show or change the extended-thinking level" },
  { name: "/clear", description: "clear conversation history (keeps session)" },
  { name: "/compact", description: "summarize history into a single message" },
  { name: "/resume", description: "switch to a saved session" },
  { name: "/predict", description: "show or toggle next-input prediction" },
  { name: "/exit", description: "leave the REPL" },
  { name: "/quit", description: "leave the REPL" },
];

export const HELP_TEXT = `Commands:
  /help              show this help
  /model [<name>]    show or change the active model
  /think [<level>]   show or change extended thinking (off|low|medium|high|max or a positive integer budget)
  /clear             clear conversation history (keeps session)
  /compact [focus…]  summarize history into a single message (optional focus hint)
  /resume [<id>]     switch to a saved session (no arg = pick from list)
  /predict [on|off]  show or toggle next-input prediction placeholder
  /exit, /quit       leave the REPL (Ctrl+D also works)`;

export const TOOL_SPINNER_DELAY_MS = 300;
