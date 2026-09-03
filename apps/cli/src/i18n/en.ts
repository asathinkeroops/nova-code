/**
 * The canonical English catalog — the source of truth for the TUI's static text
 * and the shape every other locale is a deep-partial of. Entries are plain
 * strings, or `(params) => string` functions where a value needs interpolation
 * or pluralization.
 *
 * INVARIANT: strings here must stay byte-identical to the literals they replaced
 * in the UI source, so existing tests (which assert English output) keep passing
 * with the default locale.
 *
 * Grouped by UI area. Add new areas as namespaces; a locale file overrides only
 * the leaves it translates (see `zh.ts`), everything else falls back to English.
 */
export const en = {
  /** Footers/labels shared verbatim across several overlays. */
  common: {
    footerClose: "enter/esc/q close",
    footerNavConfirm: "↑↓ navigate · enter confirm · esc cancel",
    footerScrollClose: "↑↓ scroll · enter/esc/q close",
    footerNavTopBottomClose: "↑↓ navigate · ⌃a/⌃e top/bottom · enter/esc close",
    saveFailed: (msg: string): string => `failed to save settings: ${msg}`,
  },

  /** Built-in slash-command one-line descriptions, keyed by command name. */
  commands: {
    help: "show this help",
    effort: "show or change the extended-thinking level",
    loop: "re-run a prompt or slash command on a fixed interval",
    model: "show or switch the active model tier",
    clear: "start a fresh session (the current one stays resumable)",
    compact: "summarize history into a single message",
    rename: "give this session a custom name (shown on the input frame)",
    resume: "switch to a saved session in this workspace",
    rewind: "rewind history to a previous message (history after it is discarded)",
    sandbox: "enable/disable the OS command sandbox for this session",
    init: "generate or refresh NOVA.md by analyzing the codebase",
    plan: "plan a task via a read-only plan sub-agent (no implementation)",
    diff: "browse uncommitted changes in a modal: file list → per-file diff",
    review: "review the uncommitted diff, or a GitHub PR by number (read-only)",
    goal: "set, show, or clear a success condition Nova auto-works toward",
    predict: "show or toggle next-input prediction",
    commands: "list registered slash commands; use `reload` to rescan files",
    skills: "list discovered skills (SKILL.md)",
    agents: "list available sub-agent types; `reload` to rescan agent files",
    agent: "delegate a task to a named sub-agent",
    novaCodeGuide: "ask a read-only guide about Nova itself, answered from its source",
    novaCodeGuideUpdate: "manually (re)fetch the Nova source the guide reads (remote mode)",
    tasks: "view and manage background commands (bash run_in_background)",
    mcp: "open the MCP server menu (authenticate, reconnect, log out); `tools` to list",
    lsp: "show configured language servers and their status",
    doctor: "re-check the global nova config (press f to have the agent fix issues)",
    plugin: "list loaded plugins (manage them with the `nova plugin` CLI)",
    usage: "show this session's token usage and cache hit rate",
    context: "visualize the context window: what fills it, by category",
    exit: "leave the REPL",
    quit: "leave the REPL",
  },

  /** Permission approval modal (`ui/approval.tsx`). */
  approval: {
    read: "Allow reading this file?",
    write: "Allow writing this file?",
    edit: "Allow editing this file?",
    bash: "Allow running this command?",
    glob: "Allow searching for files?",
    grep: "Allow searching file contents?",
    webfetch: "Allow fetching this URL?",
    websearch: "Allow searching the web?",
    createSubAgent: "Allow spawning a subagent?",
    monitor: "Allow starting this monitor? Every line it prints becomes a notification.",
    runInBackground: "Allow running this command in the background?",
    fallback: "Allow this operation?",
    allowOnce: "Allow once",
    deny: "Deny",
    alwaysAllow: "Always allow this tool",
  },

  /**
   * Agent-driven plan mode (`enterPlanMode` / `exitPlanMode`, wired in
   * `context.ts`): the approval question asked before leaving plan mode. The
   * plan itself is not re-rendered — the tool-call row already shows it.
   */
  planMode: {
    question: "Exit plan mode and start implementing this plan?",
    header: "Plan",
    approve: "Yes, implement it",
    approveHint: "Turns plan mode off; write/edit/bash are enabled again.",
    reject: "No, keep planning",
    rejectHint: "Stays read-only and ends the turn. Pick “Other” to say what to change.",
  },

  /** Shared tool-call rendering fragments (`ui/render-strings.ts`, approval). */
  tool: {
    /** Standalone "truncated" notice; callers add any leading space/indent. */
    truncatedNotice: "… (truncated)",
  },

  /**
   * Message-feed rendering (`ui/render-strings.ts`): banner tagline, the
   * thinking header, collapse hints, and folded-batch summaries. Tool-name
   * headers (bash/read/edit/grep/…), file paths, and metric tokens (line/bytes/
   * match counts) intentionally stay in English — they mirror the actual tool
   * identifiers and command output.
   */
  render: {
    tagline:
      "The coding agent for Chinese LLMs — high cache hit rate · OS-sandboxed · tool-complete · install-and-go. ",
    thinking: "thinking",
    redacted: "(redacted)",
    showLess: "… show less",
    moreLines: (n: number): string => `… +${n} lines`,
    /** Diff / file-preview truncation notice (`ui/diff.ts`). */
    linesTruncated: (n: number): string => `… (${n} more line${n === 1 ? "" : "s"} truncated)`,
    /** Collapsed tool-body hint (`ui/diff.ts` `compactBody`). */
    collapsedHint: (n: number): string =>
      `… (${n} more line${n === 1 ? "" : "s"} hidden — collapsed after completion)`,
    noOutput: "(no output)",
    // Folded tool-batch summary segments; the first keeps its capital, the join
    // lowercases the leading char of later segments (a no-op for non-Latin text).
    batchSearched: (n: number): string => `Searched for ${n} pattern${n === 1 ? "" : "s"}`,
    batchRead: (n: number): string => `Read ${n} file${n === 1 ? "" : "s"}`,
    batchRan: (n: number): string => `Ran ${n} shell command${n === 1 ? "" : "s"}`,
    /** "Jump to bottom" button shown above the InputBox while scrolled up. */
    jumpToBottom: " Jump to bottom (click) ↓ ",
    // Banner metadata labels (colon included). The renderer pads them to a
    // common display width, so translations need not match in length.
    bannerModel: "model:",
    bannerWorkspace: "workspace:",
    bannerSession: "session:",
  },

  /** Status line + permission/shell mode indicators (`ui/status-*`). */
  status: {
    modeHint: "(shift+tab to cycle)",
    shellMode: "! for shell mode",
    manualMode: "○ manual mode on",
    acceptEdits: "⏵⏵ accept edits on",
    autoMode: "✦ auto mode on",
    planMode: "⏸ plan mode on",
    bypass: "⚠ bypass permissions on",
    backgroundRunning: (n: number): string =>
      `${n} background task${n === 1 ? "" : "s"} running`,
    // Trailing labels on the cumulative-usage row (follow a number/amount).
    usageBalance: "balance",
    // The cache segment leads with its label and carries two rates:
    // `cache 90% session 99% total` — this session, and all-time across every
    // session. Either half drops when it has no data yet.
    usageCache: "cache",
    usageCacheSession: "session",
    usageCacheTotal: "total",
    usageIn: "in",
    usageOut: "out",
  },

  /** Working-spinner labels and hints (`hooks.ts`, `ctx-runtime.ts`, `repl.ts`). */
  spinner: {
    // Whimsical rotating verbs shown while the model works; one is picked at random.
    workingWords: [
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
    ],
    interruptHint: "esc to interrupt",
    skipHint: "esc to skip",
    thinkingAhead: "Thinking ahead...",
    runningShell: "Running shell...",
    verifyingGoal: "Verifying goal...",
  },

  /** Task/todo footers (`ui/task-footer.tsx`, `ui/todo-footer.tsx`). */
  footer: {
    taskLabel: "TASK:",
    todoLabel: "TODO:",
    summary: (hidden: number, completed: number, pending: number, inProgress: number): string =>
      `... ${hidden} More, ${completed} completed, ${pending} pending, ${inProgress} in_progress`,
  },

  /** The `/effort` reasoning-depth picker + result cards (`commands/effort.ts`). */
  effort: {
    faster: "Faster",
    smarter: "Smarter",
    footer: "← → navigate · enter confirm · esc cancel",
    blurbOff:
      "Extended thinking off — the fastest replies. Best for simple edits and quick questions.",
    blurbLow:
      "Light reasoning (~2k tokens). A small budget for straightforward, single-step tasks.",
    blurbMedium: "Balanced reasoning (~8k tokens). A solid default for everyday work.",
    blurbHigh:
      "Deep reasoning (~16k tokens). For harder, multi-step problems worth the extra latency.",
    blurbMax:
      "Maximum reasoning (~32k tokens). May use excessive tokens and overthink — use sparingly for the hardest tasks.",
    setTo: "thinking set to",
    budgetSetTo: "thinking budget set to",
    budgetSuffix: (level: string): string => `tokens (level: ${level}, this session)`,
    expected: "expected off|low|medium|high|max or a positive integer",
    saveFailed: (msg: string): string => `failed to save settings: ${msg}`,
  },

  /** The `/model` picker + overlays (`commands/model.ts`). */
  model: {
    footerClose: "enter/esc/q close",
    navFooter: "↑↓ navigate · enter confirm · esc cancel",
    selectModel: "select model",
    setTo: "model set to",
    saveFailed: (msg: string): string => `failed to save settings: ${msg}`,
    unknownTier: "unknown tier",
    configuredTiers: "configured tiers:",
    currentModel: "current model:",
    noTiers: 'no tiers configured — add a "models" map to nova.config.json',
  },

  /** The `/sandbox` status/result cards + spinner (`commands/sandbox.ts`). */
  sandbox: {
    enabling: "Enabling sandbox",
    disabling: "Disabling sandbox",
    unknownArg: (arg: string, title: string): string =>
      `unknown argument "${arg}" — use ${title} on|off`,
    label: "sandbox",
    labelColon: "sandbox:",
    on: "on",
    off: "off",
    active: "active",
    inactive: "inactive",
    confined: "— subprocess writes confined to the workspace",
    requestedInactive: (reason: string): string => `sandbox requested but inactive: ${reason}`,
    unknownReason: "unknown reason",
    failedTitle: (title: string): string => `${title} failed`,
    saveFailed: (msg: string): string =>
      `sandbox toggled for this session, but saving to config failed: ${msg}`,
    disableWith: "disable with",
    enableWith: "enable with",
  },

  /** The `/predict` status/result cards (`commands/predict.ts`). */
  predict: {
    label: "predict:",
    on: "on",
    off: "off",
    expected: "expected on or off",
    saveFailed: (msg: string): string => `failed to save settings: ${msg}`,
    setTo: "predict set to",
  },

  /** The `/rename` session-name command (`commands/rename.ts`). */
  rename: {
    currentName: (name: string): string => `current name: ${name}`,
    noNameSet: "no custom name set. usage: /rename <name> (or /rename clear)",
    cleared: "session name cleared",
    emptyError: "name is empty after trimming whitespace",
    renamedTo: (name: string): string => `renamed session to "${name}"`,
  },

  /** REPL-level user feedback (`repl.ts`): bang, cron, goal eval, clipboard. */
  repl: {
    bangUsage: "usage: !<shell command>",
    noOutput: "(no output)",
    cronIteration: (count: number, max: number, when: string): string =>
      `iteration ${count}/${max} · ${when}`,
    cronCapped: (title: string, max: number): string =>
      `${title} reached its ${max}-iteration cap; stopping.`,
    goalCheckSkipped: (msg: string): string => `goal check skipped: ${msg}`,
    goalAchieved: "🎯 goal achieved:",
    goalNotReached: (n: number): string => `goal not reached after ${n} continuation(s); stopping.`,
    goalContinuing: (n: number, max: number): string =>
      `goal not yet met — continuing (${n}/${max})`,
    stopHookCapped: (max: number): string =>
      `Stop hook kept blocking; stopping after ${max} continuations`,
    stopHookTitle: "Stop hook",
    clipboardEmpty: "clipboard is empty",
    imageAttached: "📎 image attached",
    imageNotSupported: "⚠ current model can't read images — path inserted anyway",
  },

  /** The `/tasks` background-command manager (`commands/tasks.ts`). */
  tasks: {
    running: "running",
    done: "done",
    failed: "failed",
    countRunning: (n: number): string => `${n} running`,
    countFinished: (n: number): string => `${n} finished`,
    none: "no background tasks",
    alreadyFinished: (id: string): string => `task ${id} had already finished`,
    stopping: (id: string, cmd: string): string => `stopping ${id} (${cmd})…`,
    noneDot: "no background tasks.",
    noRunning: "no running tasks to stop.",
    stoppingN: (n: number): string => `stopping ${n} task${n === 1 ? "" : "s"}…`,
    usage: "usage: /tasks stop <id|all>",
    unknownAction: (verb: string): string => `unknown action "${verb}" — try: list, stop <id|all>`,
    monitorsHeader: "monitors",
    eventCount: (n: number) => `${n} event${n === 1 ? "" : "s"}`,
    noneHint: "no background tasks — start one with bash's run_in_background.",
    header: "Background tasks",
    listFooter: "↑↓ navigate · enter open · esc close",
    viewOutput: "View output",
    stop: "Stop",
    actionFooter: "←→ choose · enter select · esc back",
    noOutputYet: "(no output yet)",
    viewerFooter: "↑↓/PgUp/PgDn scroll · g/G top/bottom · enter/esc/q back",
  },

  /** The `/agents` picker + reload/status cards (`commands/agents.ts`). */
  agents: {
    // Source-origin tags shown per row; en padded so all three align to width 9.
    sourceTag: {
      builtin: "[builtin]",
      user: "[user]   ",
      project: "[project]",
    },
    metaReadOnly: "read-only",
    metaTools: (list: string): string => `tools: ${list}`,
    metaModel: (model: string): string => `model: ${model}`,
    disabled: "sub-agents disabled in settings.",
    reloadShadowed: (n: number, names: string): string => `${n} shadowed by built-ins (${names})`,
    reloadErrors: (n: number): string => `${n} error(s) — see log`,
    reloadedCard: (loaded: number, ms: number, tail: string): string =>
      `reloaded ${loaded} custom agent(s) in ${ms}ms${tail}`,
    unknownSubcommand: (arg: string): string =>
      `unknown subcommand "${arg}". try /agents or /agents reload.`,
    headerCount: (n: number): string => `${n} agent${n === 1 ? "" : "s"}`,
    pickerFooter:
      "delegate with /agent <name> <task> · ↑↓ navigate · ⌃a/⌃e top/bottom · enter/esc close",
  },

  /** The `/agent` delegation command error messages (`commands/agent.ts`). */
  agentCmd: {
    disabled: "sub-agents are disabled in settings.",
    usage: "usage: /agent <name> <task>",
    unknownAgent: (name: string): string => `unknown sub-agent "${name}". available: `,
    usageWithName: (name: string): string => `usage: /agent ${name} <task>`,
  },

  /** The `/clear` command (`commands/clear.ts`). */
  clear: {
    alreadyFresh: (id: string): string => `already on a fresh session ${id}`,
    startedFresh: (id: string): string => `started fresh session ${id}`,
  },

  /** The `/commands` slash-command list overlay (`commands/commands.ts`). */
  cmdList: {
    reloaded: (files: number, skills: number, ms: number, tail: string): string =>
      `reloaded ${files} file command(s), ${skills} skill(s) in ${ms}ms${tail}`,
    reloadErrors: (errors: number): string => ` · ${errors} error(s) — see log`,
    unknownSubcommand: (arg: string): string =>
      `unknown subcommand "${arg}". try /commands or /commands reload.`,
    noneRegistered: "no commands registered.",
    count: (n: number): string => `${n} command${n === 1 ? "" : "s"}`,
  },

  /** The `/compact` command (`commands/compact.ts`). */
  compact: {
    nothingToCompact: "nothing to compact (empty history).",
    compacting: "Compacting",
    blocked: (reason?: string): string =>
      `compaction blocked by PreCompact hook${reason ? `: ${reason}` : ""}`,
    completed: (seconds: string, before: number, after: number): string =>
      `${seconds}s · context ${before} → ${after} msgs`,
    failedTitle: "/compact failed",
  },

  /** The `/context` context-window visualization (`commands/context.ts`). */
  contextView: {
    labelSystemPrompt: "system prompt",
    labelMemoryFiles: "memory files",
    labelSkills: "skills",
    labelTools: "tools",
    labelMcpTools: "mcp tools",
    labelMessages: "messages",
    labelFreeSpace: "free space",
    labelAutocompactBuffer: "autocompact buffer",
  },

  /** The `/diff` file-list picker + per-file diff viewer (`commands/diff.ts`). */
  diff: {
    notGitRepo: "not a git repository.",
    matchingScope: (pathspec: string): string => ` matching "${pathspec}"`,
    cleanTree: (scope: string): string => `working tree clean — no changes${scope}.`,
    changedFiles: (n: number): string => `${n} changed file${n === 1 ? "" : "s"}:`,
    listFooter: "↑↓ navigate · enter view diff · esc close",
    noTextualDiff: "no textual diff (binary file or no content change).",
    viewerFooter: "↑↓/PgUp/PgDn scroll · g/G top/bottom · enter/esc/q back to list",
    untracked: "untracked",
    staged: (word: string): string => `staged ${word}`,
    unstaged: (word: string): string => `unstaged ${word}`,
    statusWord: (letter: string): string => {
      const words: Record<string, string> = {
        M: "modified",
        A: "added",
        D: "deleted",
        R: "renamed",
        C: "copied",
        T: "typechange",
        U: "conflict",
        "?": "untracked",
      };
      return words[letter] ?? letter;
    },
  },

  /** The `/lsp` language-server status viewer (`commands/lsp.ts`). */
  lsp: {
    disabled: "LSP is disabled (settings.lsp.enabled = false).",
    noneConfigured: "no language servers configured.",
    running: "● running",
    installed: "○ installed",
    notInstalled: "● not installed",
    summary: (installed: number, total: number, running: number): string =>
      `${installed}/${total} installed · ${running} running`,
    missingNote: "missing servers must be installed on PATH (Nova does not install them)",
  },

  /** The `/loop` command (`commands/loop.ts`). */
  loop: {
    usage: "usage: /loop <interval> <prompt|/command>  ·  /loop stop  ·  interval like 30s, 5m, 1h",
    loopingEvery: (every: string, n: number, max: number): string =>
      `looping every ${every} (${n}/${max})`,
    stopped: "loop stopped",
    noActive: "no active loop",
    invalidInterval: (interval: string): string =>
      `invalid interval "${interval}" — expected e.g. 30s, 5m, 1h.`,
    missingPayload: "missing prompt or command to loop.",
    intervalTooShort: (min: string): string =>
      `interval too short — minimum is ${min} (settings.loop.minIntervalMs).`,
    noSelfNesting: "a loop can't run /loop as its payload.",
    startedCard: (replaced: boolean, interval: string, max: number): string =>
      `${replaced ? "replaced loop — " : ""}running now, then every ${interval}` +
      ` after each run completes (max ${max}). /loop stop to end.`,
  },

  /** The `/resume` session picker + notices (`commands/resume.ts`). */
  resume: {
    noSessions: "no sessions to resume in this workspace.",
    notFound: (id: string): string => `session ${id} not found.`,
    workspaceUnknown: (id: string, current: string): string =>
      `session ${id} has no workspace binding and cannot be resumed from ${current}.`,
    workspaceMismatch: (id: string, bound: string, current: string): string =>
      `session ${id} belongs to workspace ${bound}, not the current workspace ${current}. ` +
      `Start Nova in ${bound} to resume it.`,
    header: "select a session from this workspace:",
    alreadyOn: "already on that session.",
    /** Ephemeral card shown above a restored history (`context.ts`). */
    loadedMessages: (n: number): string => `loaded ${n} message(s) from disk`,
    /** Warned when history lines were unreadable and skipped (`session.ts`). */
    skippedMessages: (n: number): string =>
      `skipped ${n} unreadable line(s) in the history; see the session log`,
    /** Printed after the REPL exits, so the thread can be picked back up. */
    exitHint: "Resume this session with:",
  },

  /** The `/skills` list (`commands/skills.ts`). */
  skills: {
    disabled: "skills disabled in settings.",
    none: "no skills found.",
    count: (n: number): string => `${n} skill${n === 1 ? "" : "s"}`,
  },

  /** The `/usage` token-usage overlay (`commands/usage.ts`). */
  usage: {
    noRequests: "no model requests yet this session.",
    cacheHitRate: "cache hit rate",
    cacheHitRateHint: "(cache read / all prompt tokens)",
    promptTokens: "prompt tokens",
    cacheRead: "  cache read",
    cacheWrite: "  cache write",
    uncached: "  uncached",
    outputTokens: "output tokens",
    costEst: "cost (est.)",
    noPrice: (model: string): string =>
      `no price for "${model}" — add "pricing" to that model tier in nova.config.json`,
  },

  /** `/rewind` — pick a prior message to rewind history to (`commands/rewind.ts`). */
  rewind: {
    nothingToRewind: "nothing to rewind to.",
    expectedTurnCount: (count: number): string => `expected a turn count (1-${count}).`,
    onlyNTurns: (count: number): string => `only ${count} user turn(s) to rewind through.`,
    pickerHeader: "rewind to which message? everything after it is discarded:",
    restoreHeader: (modify: number, remove: number): string =>
      `will restore ${modify} file(s), delete ${remove} newly-created file(s):`,
    noneRevertable: "no files can be auto-reverted (all changed outside nova):",
    conflictNote: (count: number): string =>
      `${count} file(s) changed outside nova since that turn — left untouched to avoid clobbering newer work:`,
    confirmFooter: "←→ navigate · enter confirm · esc cancel",
    restoreAndRewind: "restore & rewind",
    rewindHistoryOnly: "rewind history only",
    cancel: "cancel",
    cancelledNothingChanged: "cancelled; nothing changed.",
    restoreFailed: (msg: string): string => `file restore failed: ${msg}`,
    fileNote: (count: number): string => ` restored ${count} file(s).`,
    skipNote: (count: number): string => ` skipped ${count} file(s) changed outside nova.`,
    rewoundSummary: (p: {
      turn: number;
      dropped: number;
      fileNote: string;
      skipNote: string;
    }): string =>
      `rewound to turn #${p.turn}; dropped ${p.dropped} message(s).${p.fileNote}${p.skipNote} ` +
      `your message is back in the prompt (→ to edit).`,
  },

  /** Config check ("doctor") report + modal (`doctor.ts`, `commands/doctor.ts`). */
  doctor: {
    configCheckTitle: "nova config check",
    configCheckHeader: "config check",
    noConfigFileModal: "no config file yet — first-time setup runs on launch.",
    noConfigFile: "no config file yet — nova will run first-time setup on launch.",
    looksGood: "✓ config looks good",
    contextUsage: (p: {
      used: string;
      window: string;
      pct: string;
      system: string;
      tools: string;
      mcp: number;
      messages: string;
    }): string =>
      `context: ${p.used} / ${p.window} (${p.pct}) — system ${p.system}, tools ${p.tools}` +
      `${p.mcp > 0 ? ` (${p.mcp} mcp)` : ""}, messages ${p.messages}`,
    labelFix: "Fix issues",
    labelClose: "Close",
    footerFix: "f fix · ←/→ choose · Enter confirm · Esc close",
    footerClose: "Enter / Esc to close",
    summary: (errors: number, warnings: number): string =>
      `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
    configUnreadableTitle: "config file could not be read",
    configUnreadableHint: (path: string): string => `check permissions on ${path}`,
    invalidJsonTitle: "config is not valid JSON",
    invalidJsonHint: (path: string): string => `fix the syntax in ${path}`,
    invalidSettingTitle: (path: string): string => `invalid setting: ${path}`,
    configFailedValidationTitle: "config failed validation",
    noApiKeyTitle: "no apiKey configured",
    noApiKeyHint:
      'nova will run first-time setup, or add "apiKey" to the current providers[] entry / export $NOVA_API_KEY',
    apiKeyFromEnv: (envVar: string): string =>
      `apiKey: taken from $${envVar} (overrides the config file)`,
    noModelsTitle: "apiKey is set but no models are configured",
    noModelsHint: (tiers: string): string =>
      `add a "models" table with all tiers to the current providers[] entry (${tiers})`,
    unknownProviderTitle: (provider: string): string =>
      `provider "${provider}" is not a built-in profile`,
    unknownProviderDetail: `using the generic "other" fallback (no effort knob, error translation, or balance)`,
    unknownProviderHint: (providers: string): string =>
      `set "profile" on the current providers[] entry to one of: ${providers} — or keep it if this endpoint is a plain Anthropic-compatible one`,
    invalidHookFileTitle: (name: string): string => `invalid hook file: ${name}`,
    invalidHookFileHint: "fix or remove it — nova skips it and continues",
    mcpDisabled: "MCP: disabled (mcp.enabled = false)",
    mcpNoServers: "MCP: no servers configured",
    mcpConfigured: (p: {
      total: number;
      stdio: number;
      http: number;
      disabled: number;
    }): string => {
      const kinds = [p.stdio > 0 ? `${p.stdio} stdio` : "", p.http > 0 ? `${p.http} http` : ""]
        .filter(Boolean)
        .join(", ");
      let line = `MCP: ${p.total} server(s) configured${kinds ? ` (${kinds})` : ""}`;
      if (p.disabled > 0) line += ` · ${p.disabled} disabled`;
      return line;
    },
    projectHooksLoaded: (n: number): string => `project hooks: loaded ${n} file(s)`,
    invalidHeadline: "your nova config has errors and can't be used as written:",
    invalidFixHint: (path: string): string => `fix ${path} (or run \`nova doctor\`) and re-launch.`,
  },

  /** The `/mcp` server menu, action cards, and browser-auth modal (`commands/mcp.ts`). */
  mcp: {
    disabled: "MCP is disabled (settings.mcp.enabled = false).",
    noServers: "no MCP servers configured. Add them under `mcp.servers` in nova.config.json.",
    serversHeader: "MCP servers",
    connectedSummary: (connected: number, total: number, pending: number): string =>
      `  ${connected}/${total} connected` + (pending > 0 ? ` · ${pending} need auth` : ""),
    footerSelectOpen: "↑↓ select · enter open · esc close",
    viewToolsLabel: "View tools",
    logOut: "Log out",
    reconnect: "Reconnect",
    authenticate: "Authenticate",
    back: "Back",
    footerSelectRun: "↑↓ select · enter run · esc back",
    cannotAuthorize: "cannot authorize:",
    notRemoteOAuth: (name: string): string =>
      `"${name}" is not a remote server that supports OAuth — add "oauth": {} to its server config.`,
    callbackServerFailed: "could not start the OAuth callback server",
    callbackServerOn: (host: string, port: number): string => ` on ${host}:${port}.\n`,
    freePort: "Free the port or change settings.mcp.oauth.callbackPort.",
    authDidNotComplete: "authorization did not complete:",
    authRejectedCsrf: "authorization rejected: state mismatch (possible CSRF). Try again.",
    authorized: "✓ authorized",
    toolsNowAvailable: (n: number): string => ` — ${n} tool(s) now available.`,
    authFailed: "authorization failed:",
    reconnected: "✓ reconnected",
    toolsAvailable: (n: number): string => ` — ${n} tool(s) available.`,
    needsAuthWord: "needs auth",
    reconnectChoose: " — choose ",
    reconnectFor: " for ",
    reconnectDot: ".",
    stillFailed: "still failed:",
    couldNotConnect: "could not connect",
    loggedOut: "✓ logged out",
    clearedTokens: (n: number): string => ` — cleared tokens; ${n} tool(s) removed.`,
    toolCountSuffix: (n: number): string => ` — ${n} tool(s)`,
    noToolsBridged: "(no tools bridged)",
    footerEscClose: "esc / q to close",
    badgeConnected: "● connected",
    badgeNeedsAuth: "● needs auth",
    badgeFailed: "● failed",
    badgeDisabled: "● disabled",
    rowCountsConnected: (
      transport: string,
      tools: number,
      prompts: number,
      resources: number,
    ): string =>
      ` ${transport} · ${tools} tool(s)` +
      (prompts > 0 ? ` · ${prompts} prompt(s)` : "") +
      (resources > 0 ? ` · ${resources} resource(s)` : ""),
    cardMetaConnected: (
      transport: string,
      tools: number,
      prompts: number,
      resources: number,
    ): string =>
      `${transport} · ${tools} tool(s)` +
      (prompts > 0 ? ` · ${prompts} prompt(s)` : "") +
      (resources > 0 ? ` · ${resources} resource(s)` : ""),
    summaryLine: (
      connected: number,
      total: number,
      bridged: number,
      prompts: number,
      resourceServers: number,
    ): string =>
      `${connected}/${total} connected · ${bridged} tool(s) bridged` +
      (prompts > 0 ? ` · ${prompts} prompt(s)` : "") +
      (resourceServers > 0 ? ` · resources on ${resourceServers} server(s)` : ""),
    pendingHint: (pending: string): string =>
      `run \`/mcp\` and choose Authenticate — pending: ${pending}`,
    toolsHint: "run `/mcp tools` to list bridged tool & prompt names",
    waitingForAuth: "Waiting for browser authorization",
    approveInBrowser: "Approve the request in your browser, then return here.",
    ifNotOpened: "If it didn't open, visit:",
    pressEscCancel: "press esc to cancel",
    timedOut: (seconds: number): string => `timed out after ${seconds}s`,
  },

  /** The `/goal` success-condition command (`commands/goal.ts`). */
  goal: {
    noActiveGoal: "no active goal.",
    setOneWith: "set one with",
    activeGoal: "active goal:",
    autoContinuations: (n: number, max: number): string => `auto-continuations: ${n}/${max}`,
    noGoalToClear: "no active goal to clear.",
    cleared: "cleared goal:",
    disabled: "goal mode is disabled (settings.goal.enabled = false).",
    set: "goal set:",
    setHelp:
      "Nova will work toward this now and re-check after each turn until it's met. " +
      "Run /goal clear to stop.",
  },

  /** The `/help` command list (`commands/help.ts`). */
  help: {
    sectionBuiltin: "Built-in",
    sectionProject: "Project",
    sectionUser: "User",
    sectionSkill: "Skills",
    sectionMcp: "MCP",
    sectionPlugin: "Plugins",
    pasteHint:
      "Paste an image (Cmd/Ctrl+V) or drag a file in — it's inserted as a path the model reads.",
    leaveHint:
      "Ctrl+D or /exit to leave. /commands lists everything; /commands reload re-scans files.",
    commandCount: (n: number): string => `${n} command${n === 1 ? "" : "s"}`,
    navFooter: "↑↓ navigate · ⌃a/⌃e top/bottom · enter/esc close",
  },

  /** Lifecycle hook feedback cards (`hooks.ts`). */
  hooks: {
    autoCompact: (before: number, after: number): string => `context ${before} → ${after} msgs`,
    autoCompactTitle: "auto-compact",
    requestFailed: (word: string, seconds: string, error: string): string =>
      `${word} · ${seconds}s · ${error}`,
    requestFailedTitle: "request failed",
    loopTerminated: (message: string, logPath: string): string => `${message}\nsee log: ${logPath}`,
    loopTerminatedTitle: "loop terminated",
  },

  /** Startup update-check cards (`update.ts`). */
  update: {
    available: "available",
    availableTitle: "update available",
    installed: "installed in the background",
    installedTitle: "update installed",
    youHave: (version: string): string => `(you have ${version})`,
    runUpgrade: (command: string): string => `run ${command} to update`,
    effectiveNextLaunch: "it takes effect the next time you start nova",
  },

  /** Input box chrome (`ui/input-box.tsx`): queued prompts, history, popup. */
  input: {
    // Embedded in the top frame rule; keep the leading/trailing spaces.
    history: (pos: number, total: number): string => ` History ${pos}/${total} `,
    moreQueued: (n: number): string => ` ↳ +${n} more queued`,
    moreAbove: (n: number): string => `${n} more`,
  },

  /** First-run provider setup (`ui/setup-view.tsx`). */
  setup: {
    tagline:
      "The coding agent for Chinese LLMs — high cache hit rate · OS-sandboxed · tool-complete",
    welcome: "Welcome to Nova!",
    missing: (n: number): string =>
      `Missing ${n} setting${n === 1 ? "" : "s"} — let's configure them. (Ctrl+C to abort)`,
    configSavedTo: (path: string): string => `Config will be saved to: ${path}`,
    noteBaseURL: "Note: baseURL must point to an Anthropic-compatible API endpoint.",
    providerQuestion: "Which provider are you connecting to?",
    providerFooter: "↑/↓ to choose · Enter to confirm · Ctrl+C to abort",
    otherProvider: "Other provider",
    recommended: "★ recommended",
    beta: "Beta",
    aborted: "setup aborted.",
    apiKeyLabel: "API key",
    apiKeyEmpty: "✗ API key cannot be empty",
    saved: (label: string): string => `✓ saved ${label} settings`,
    manualIntro: (path: string): string =>
      `To use another provider, create your config file at: ${path}`,
    manualShape: "with settings shaped like:",
    manualRerun: "Then run nova again.",
  },

  /** AskUserQuestion interactive modal (`ui/ask-user.tsx`). */
  ask: {
    other: "Other",
    otherDesc: "type a custom answer",
    confirm: "Confirm",
    reviewSubmit: "Review your answers and submit.",
    noAnswer: "(no answer)",
    submit: "Submit",
    cancel: "Cancel",
    answerAllFirst: "  (answer all questions first)",
    freeformHint: "type your custom answer, Enter to confirm, Esc to cancel",
    navOption: "↑/↓ choose",
    navButton: "↑/↓ button",
    navPick: (count: number): string => (count > 1 ? `1-${count} pick` : "1 pick"),
    navToggle: "space toggle",
    navQuestion: "←/→ tab",
    navFreeform: "enter confirm · esc cancel",
    navNext: "enter next",
    navActivate: "enter activate",
    navCancel: "esc cancel",
  },

  /** Workspace-trust gate (`ui/trust-view.tsx`, `workspace-trust.ts`). */
  trust: {
    question: "Do you trust the files in this folder?",
    lines: [
      "nova has not been granted access to this folder yet. Granting access",
      "lets it read and edit files here (and in subdirectories) without",
      "confirming each time, and runs any project hooks the folder defines.",
      "Only trust folders you recognize — declining exits without touching",
      "anything.",
    ],
    footer: "↑/↓ choose · Enter confirm · Ctrl+C to exit",
    yes: "Yes, trust this folder",
    no: "No, exit",
    exiting: (path: string): string => `workspace not trusted — exiting.\n  ${path}`,
    persistFailed: (msg: string): string => `could not persist workspace trust: ${msg}`,
    persistFailedTitle: "workspace trust",
  },
};

export type Catalog = typeof en;
