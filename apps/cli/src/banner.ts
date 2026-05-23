import { cyan, dim } from "./colors.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

export interface BannerInput {
  version: string;
  model: string;
  cwd: string;
  home?: string;
}

export function renderBanner(opts: BannerInput): string {
  const home = opts.home ?? "";
  const cwdDisplay =
    home && (opts.cwd === home || opts.cwd.startsWith(home + "/"))
      ? "~" + opts.cwd.slice(home.length)
      : opts.cwd;

  const lines = [
    `${cyan(">_")} Nova Coding Agent ${dim(`(v${opts.version})`)} `,
    "",
    cyan("███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ "),
    cyan("████╗  ██║██╔═══██╗██║   ██║██╔══██╗"),
    cyan("██╔██╗ ██║██║   ██║██║   ██║███████║"),
    cyan("██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║"),
    cyan("██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║"),
    cyan("╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝"),
    "",
    `${dim("model:")}     ${opts.model}    ${dim("/model to change")}`,
    `${dim("directory:")} ${cwdDisplay}`
  ];

  const inner = Math.max(...lines.map((l) => stripAnsi(l).length));
  const horiz = "─".repeat(inner + 2);
  const pad = (l: string): string => {
    const visible = stripAnsi(l).length;
    return `│ ${l}${" ".repeat(inner - visible)} │`;
  };

  return [`╭${horiz}╮`, ...lines.map(pad), `╰${horiz}╯`].join("\n");
}
