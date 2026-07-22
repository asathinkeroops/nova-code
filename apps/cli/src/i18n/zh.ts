/**
 * Simplified-Chinese catalog. A deep-partial of the English shape (`Catalog`):
 * translate the leaves we cover, omit the rest — omitted keys fall back to
 * English via `deepMerge` at `setLocale`. Grouped identically to `en.ts`.
 */
import type { DeepPartial } from "./merge.js";
import type { Catalog } from "./en.js";

export const zh: DeepPartial<Catalog> = {
  common: {
    footerClose: "enter/esc/q 关闭",
    footerNavConfirm: "↑↓ 导航 · enter 确认 · esc 取消",
    footerScrollClose: "↑↓ 滚动 · enter/esc/q 关闭",
    footerNavTopBottomClose: "↑↓ 导航 · ⌃a/⌃e 顶部/底部 · enter/esc 关闭",
    saveFailed: (msg: string): string => `保存设置失败：${msg}`,
  },

  commands: {
    help: "显示帮助",
    effort: "查看或修改扩展思考等级",
    loop: "按固定间隔重复运行一段提示词或斜杠命令",
    model: "查看或切换当前模型档位",
    clear: "开启一个全新会话（当前会话仍可恢复）",
    compact: "将历史压缩为一条消息",
    rename: "为当前会话取一个自定义名称（显示在输入框边框上）",
    resume: "切换到某个已保存的会话",
    rewind: "将历史回退到之前的某条消息（其后的历史会被丢弃）",
    sandbox: "为当前会话启用/停用操作系统命令沙箱",
    init: "分析代码库以生成或刷新 NOVA.md",
    plan: "通过只读的 plan 子智能体规划任务（不做实现）",
    diff: "在弹窗中浏览未提交的改动：文件列表 → 单文件 diff",
    review: "审查未提交的 diff，或按编号审查某个 GitHub PR（只读）",
    goal: "设置、查看或清除 Nova 自动推进的成功条件",
    predict: "查看或开关下一步输入预测",
    commands: "列出已注册的斜杠命令；用 `reload` 重新扫描文件",
    skills: "列出已发现的技能（SKILL.md）",
    agents: "列出可用的子智能体类型；用 `reload` 重新扫描 agent 文件",
    agent: "把任务委派给指定的子智能体",
    novaCodeGuide: "向只读向导询问 Nova 自身，由其源码作答",
    novaCodeGuideUpdate: "手动（重新）拉取向导所读取的 Nova 源码（远程模式）",
    tasks: "查看和管理后台命令（runInBackground）",
    mcp: "打开 MCP 服务器菜单（认证、重连、登出）；用 `tools` 列出工具",
    lsp: "显示已配置的语言服务器及其状态",
    doctor: "重新检查全局 nova 配置（按 f 让智能体修复问题）",
    plugin: "列出已加载的插件（用 `nova plugin` CLI 管理）",
    usage: "显示本次会话的 token 用量与缓存命中率",
    context: "可视化上下文窗口：按类别展示其占用情况",
    exit: "退出 REPL",
    quit: "退出 REPL",
  },

  approval: {
    read: "允许读取该文件？",
    write: "允许写入该文件？",
    edit: "允许编辑该文件？",
    bash: "允许运行该命令？",
    glob: "允许搜索文件？",
    grep: "允许搜索文件内容？",
    webfetch: "允许抓取该 URL？",
    websearch: "允许联网搜索？",
    createSubAgent: "允许启动子智能体？",
    runInBackground: "允许在后台运行该命令？",
    fallback: "允许该操作？",
    allowOnce: "仅允许一次",
    deny: "拒绝",
    alwaysAllow: "始终允许该工具",
  },

  tool: {
    truncatedNotice: "…（已截断）",
  },

  render: {
    tagline:
      "专为 DeepSeek 打造的编程智能体 —— 95%+ 缓存命中 · 系统级沙箱 · 工具齐备 · 开箱即用。 ",
    thinking: "思考中",
    redacted: "（已隐去）",
    showLess: "… 收起",
    moreLines: (n: number): string => `… 还有 ${n} 行`,
    noOutput: "（无输出）",
    batchSearched: (n: number): string => `搜索了 ${n} 个模式`,
    batchRead: (n: number): string => `读取了 ${n} 个文件`,
    batchRan: (n: number): string => `运行了 ${n} 条 shell 命令`,
    jumpToBottom: " 跳到底部 (ctrl+End) ↓ ",
  },

  status: {
    modeHint: "(shift+tab 切换)",
    shellMode: "! 进入 shell 模式",
    acceptEdits: "⏵⏵ 接受编辑已开启",
    autoMode: "⏵⏵ 自动模式已开启",
    planMode: "⏸ 计划模式已开启",
    bypass: "⚠ 跳过权限已开启",
    usageBalance: "余额",
    usageCache: "缓存",
    usageIn: "输入",
    usageOut: "输出",
    usageCost: "花费",
  },

  spinner: {
    workingWords: [
      "思考中...",
      "琢磨中...",
      "运转中...",
      "钻研中...",
      "烹制中...",
      "酝酿中...",
      "孕育中...",
      "斟酌中...",
      "计算中...",
      "推理中...",
      "综合中...",
      "冥思中...",
      "权衡中...",
      "忙碌中...",
      "赶工中...",
      "捣鼓中...",
      "谋划中...",
      "筹谋中...",
    ],
    interruptHint: "按 esc 中断",
    skipHint: "按 esc 跳过",
    thinkingAhead: "提前思考中...",
    runningShell: "运行 shell 中...",
    verifyingGoal: "校验目标中...",
  },

  footer: {
    taskLabel: "任务：",
    todoLabel: "待办：",
    summary: (hidden: number, completed: number, pending: number, inProgress: number): string =>
      `... 还有 ${hidden} 项, ${completed} 已完成, ${pending} 待处理, ${inProgress} 进行中`,
  },

  effort: {
    faster: "更快",
    smarter: "更聪明",
    footer: "← → 导航 · enter 确认 · esc 取消",
    blurbOff: "关闭扩展思考 —— 回复最快。适合简单编辑和快速提问。",
    blurbLow: "轻度推理（约 2k tokens）。适合直接的单步任务的小额预算。",
    blurbMedium: "均衡推理（约 8k tokens）。日常工作的稳妥默认值。",
    blurbHigh: "深度推理（约 16k tokens）。适合值得额外延迟的多步难题。",
    blurbMax: "最强推理（约 32k tokens）。可能消耗过多 token 并过度思考 —— 仅在最难的任务上慎用。",
    setTo: "思考等级已设为",
    budgetSetTo: "思考预算已设为",
    budgetSuffix: (level: string): string => `tokens（等级：${level}，仅本次会话）`,
    expected: "预期为 off|low|medium|high|max 或一个正整数",
    saveFailed: (msg: string): string => `保存设置失败：${msg}`,
  },

  model: {
    footerClose: "enter/esc/q 关闭",
    navFooter: "↑↓ 导航 · enter 确认 · esc 取消",
    selectModel: "选择模型",
    setTo: "模型已设为",
    saveFailed: (msg: string): string => `保存设置失败：${msg}`,
    unknownTier: "未知档位",
    configuredTiers: "已配置的档位：",
    currentModel: "当前模型：",
    noTiers: '尚未配置档位 —— 在 nova.config.json 中添加 "models" 映射',
  },

  sandbox: {
    enabling: "正在启用沙箱",
    disabling: "正在停用沙箱",
    unknownArg: (arg: string, title: string): string => `未知参数 "${arg}" —— 请用 ${title} on|off`,
    label: "沙箱",
    labelColon: "沙箱：",
    on: "开",
    off: "关",
    active: "已启用",
    inactive: "未启用",
    confined: "—— 子进程写入被限制在工作区内",
    requestedInactive: (reason: string): string => `已请求沙箱但未生效：${reason}`,
    unknownReason: "未知原因",
    failedTitle: (title: string): string => `${title} 失败`,
    saveFailed: (msg: string): string => `本次会话已切换沙箱，但保存到配置失败：${msg}`,
    disableWith: "停用命令",
    enableWith: "启用命令",
  },

  predict: {
    label: "预测：",
    on: "开",
    off: "关",
    expected: "预期为 on 或 off",
    saveFailed: (msg: string): string => `保存设置失败：${msg}`,
    setTo: "预测已设为",
  },

  rename: {
    currentName: (name: string): string => `当前名称：${name}`,
    noNameSet: "未设置自定义名称。用法：/rename <名称>（或 /rename clear）",
    cleared: "会话名称已清除",
    emptyError: "名称为空（仅剩空白字符）",
    renamedTo: (name: string): string => `会话已重命名为 "${name}"`,
  },

  repl: {
    bangUsage: "用法：!<shell 命令>",
    noOutput: "（无输出）",
    cronIteration: (count: number, max: number, when: string): string =>
      `第 ${count}/${max} 次迭代 · ${when}`,
    cronCapped: (title: string, max: number): string =>
      `${title} 已达到 ${max} 次迭代上限；正在停止。`,
    goalCheckSkipped: (msg: string): string => `目标检查已跳过：${msg}`,
    goalAchieved: "🎯 目标已达成：",
    goalNotReached: (n: number): string => `目标在 ${n} 次续跑后仍未达成；正在停止。`,
    goalContinuing: (n: number, max: number): string => `目标尚未达成 —— 正在继续（${n}/${max}）`,
    stopHookCapped: (max: number): string => `Stop 钩子持续阻塞；在 ${max} 次续跑后停止`,
    stopHookTitle: "Stop 钩子",
    clipboardEmpty: "剪贴板为空",
    imageAttached: "📎 图片已附加",
    imageNotSupported: "⚠ 当前模型无法读取图片 —— 路径已插入但模型无法消费",
  },

  tasks: {
    running: "运行中",
    done: "已完成",
    failed: "失败",
    countRunning: (n: number): string => `${n} 个运行中`,
    countFinished: (n: number): string => `${n} 个已结束`,
    none: "没有后台任务",
    alreadyFinished: (id: string): string => `任务 ${id} 已经结束`,
    stopping: (id: string, cmd: string): string => `正在停止 ${id}（${cmd}）…`,
    noneDot: "没有后台任务。",
    noRunning: "没有正在运行、可停止的任务。",
    stoppingN: (n: number): string => `正在停止 ${n} 个任务…`,
    usage: "用法：/tasks stop <id|all>",
    unknownAction: (verb: string): string => `未知操作 "${verb}" —— 可试：list、stop <id|all>`,
    noneHint: "没有后台任务 —— 用 runInBackground 工具启动一个。",
    header: "后台任务",
    listFooter: "↑↓ 导航 · enter 打开 · esc 关闭",
    viewOutput: "查看输出",
    stop: "停止",
    actionFooter: "←→ 选择 · enter 确定 · esc 返回",
    noOutputYet: "（暂无输出）",
    viewerFooter: "↑↓/PgUp/PgDn 滚动 · g/G 顶部/底部 · enter/esc/q 返回",
  },

  doctor: {
    configCheckTitle: "nova 配置检查",
    configCheckHeader: "配置检查",
    noConfigFileModal: "尚无配置文件 —— 首次启动时会运行初始设置。",
    noConfigFile: "尚无配置文件 —— nova 将在启动时运行首次设置。",
    looksGood: "✓ 配置正常",
    contextUsage: (p: {
      used: string;
      window: string;
      pct: string;
      system: string;
      tools: string;
      mcp: number;
      messages: string;
    }): string =>
      `上下文：${p.used} / ${p.window}（${p.pct}）—— 系统 ${p.system}，工具 ${p.tools}` +
      `${p.mcp > 0 ? `（${p.mcp} 个 mcp）` : ""}，消息 ${p.messages}`,
    labelFix: "修复问题",
    labelClose: "关闭",
    footerFix: "f 修复 · ←/→ 选择 · Enter 确认 · Esc 关闭",
    footerClose: "Enter / Esc 关闭",
    summary: (errors: number, warnings: number): string => `${errors} 个错误，${warnings} 个警告`,
    configUnreadableTitle: "无法读取配置文件",
    configUnreadableHint: (path: string): string => `检查 ${path} 的权限`,
    invalidJsonTitle: "配置不是有效的 JSON",
    invalidJsonHint: (path: string): string => `修正 ${path} 中的语法`,
    invalidSettingTitle: (path: string): string => `无效的设置：${path}`,
    configFailedValidationTitle: "配置未通过校验",
    noApiKeyTitle: "未配置 apiKey",
    noApiKeyHint: '将运行首次设置，或在配置中添加 "apiKey"',
    noModelsTitle: "已设置 apiKey，但未配置任何模型",
    noModelsHint: (tiers: string): string => `添加包含所有层级的 "models" 表（${tiers}）`,
    unknownProviderTitle: (provider: string): string => `提供方 "${provider}" 不是内置配置`,
    unknownProviderDetail: '使用通用的 "other" 回退（无强度调节、错误翻译或余额查询）',
    unknownProviderHint: (providers: string): string =>
      `将 "provider" 设为以下之一：${providers} —— 若该端点是标准的 Anthropic 兼容端点，也可保持不变`,
    invalidHookFileTitle: (name: string): string => `无效的钩子文件：${name}`,
    invalidHookFileHint: "修复或删除它 —— nova 会跳过它并继续",
    mcpDisabled: "MCP：已禁用（mcp.enabled = false）",
    mcpNoServers: "MCP：未配置任何服务器",
    mcpConfigured: (p: { total: number; stdio: number; http: number; disabled: number }): string => {
      const kinds = [p.stdio > 0 ? `${p.stdio} 个 stdio` : "", p.http > 0 ? `${p.http} 个 http` : ""]
        .filter(Boolean)
        .join("、");
      let line = `MCP：已配置 ${p.total} 个服务器${kinds ? `（${kinds}）` : ""}`;
      if (p.disabled > 0) line += ` · ${p.disabled} 个已禁用`;
      return line;
    },
    projectHooksLoaded: (n: number): string => `项目钩子：已加载 ${n} 个文件`,
    invalidHeadline: "你的 nova 配置存在错误，无法按原样使用：",
    invalidFixHint: (path: string): string => `修复 ${path}（或运行 \`nova doctor\`）后重新启动。`,
  },

  mcp: {
    disabled: "MCP 已停用（settings.mcp.enabled = false）。",
    noServers: "未配置任何 MCP 服务器。请在 nova.config.json 的 `mcp.servers` 下添加。",
    serversHeader: "MCP 服务器",
    connectedSummary: (connected: number, total: number, pending: number): string =>
      `  ${connected}/${total} 已连接` + (pending > 0 ? ` · ${pending} 个待认证` : ""),
    footerSelectOpen: "↑↓ 选择 · enter 打开 · esc 关闭",
    viewToolsLabel: "查看工具",
    logOut: "登出",
    reconnect: "重连",
    authenticate: "认证",
    back: "返回",
    footerSelectRun: "↑↓ 选择 · enter 执行 · esc 返回",
    cannotAuthorize: "无法认证：",
    notRemoteOAuth: (name: string): string =>
      `"${name}" 不是支持 OAuth 的远程服务器 —— 请在其服务器配置中添加 "oauth": {}。`,
    callbackServerFailed: "无法启动 OAuth 回调服务器",
    callbackServerOn: (host: string, port: number): string => `，位于 ${host}:${port}。\n`,
    freePort: "请释放该端口或修改 settings.mcp.oauth.callbackPort。",
    authDidNotComplete: "认证未完成：",
    authRejectedCsrf: "认证被拒绝：状态不匹配（可能是 CSRF）。请重试。",
    authorized: "✓ 已认证",
    toolsNowAvailable: (n: number): string => ` —— 现有 ${n} 个工具可用。`,
    authFailed: "认证失败：",
    reconnected: "✓ 已重连",
    toolsAvailable: (n: number): string => ` —— ${n} 个工具可用。`,
    needsAuthWord: "需要认证",
    reconnectChoose: " —— 请选择 ",
    reconnectFor: " 用于 ",
    reconnectDot: "。",
    stillFailed: "仍然失败：",
    couldNotConnect: "无法连接",
    loggedOut: "✓ 已登出",
    clearedTokens: (n: number): string => ` —— 已清除令牌；移除了 ${n} 个工具。`,
    toolCountSuffix: (n: number): string => ` —— ${n} 个工具`,
    noToolsBridged: "（未桥接任何工具）",
    footerEscClose: "esc / q 关闭",
    badgeConnected: "● 已连接",
    badgeNeedsAuth: "● 需要认证",
    badgeFailed: "● 失败",
    badgeDisabled: "● 已停用",
    rowCountsConnected: (
      transport: string,
      tools: number,
      prompts: number,
      resources: number,
    ): string =>
      ` ${transport} · ${tools} 个工具` +
      (prompts > 0 ? ` · ${prompts} 个提示词` : "") +
      (resources > 0 ? ` · ${resources} 个资源` : ""),
    cardMetaConnected: (
      transport: string,
      tools: number,
      prompts: number,
      resources: number,
    ): string =>
      `${transport} · ${tools} 个工具` +
      (prompts > 0 ? ` · ${prompts} 个提示词` : "") +
      (resources > 0 ? ` · ${resources} 个资源` : ""),
    summaryLine: (
      connected: number,
      total: number,
      bridged: number,
      prompts: number,
      resourceServers: number,
    ): string =>
      `${connected}/${total} 已连接 · 已桥接 ${bridged} 个工具` +
      (prompts > 0 ? ` · ${prompts} 个提示词` : "") +
      (resourceServers > 0 ? ` · ${resourceServers} 个服务器提供资源` : ""),
    pendingHint: (pending: string): string =>
      `运行 \`/mcp\` 并选择“认证” —— 待认证：${pending}`,
    toolsHint: "运行 `/mcp tools` 可列出已桥接的工具和提示词名称",
    waitingForAuth: "等待浏览器认证",
    approveInBrowser: "请在浏览器中批准该请求，然后返回这里。",
    ifNotOpened: "如果没有自动打开，请访问：",
    pressEscCancel: "按 esc 取消",
    timedOut: (seconds: number): string => `在 ${seconds}s 后超时`,
  },

  agents: {
    sourceTag: { builtin: "[内置]", user: "[用户]", project: "[项目]" },
    metaReadOnly: "只读",
    metaTools: (list: string): string => `工具：${list}`,
    metaModel: (model: string): string => `模型：${model}`,
    disabled: "子智能体已在设置中停用。",
    reloadShadowed: (n: number, names: string): string => `${n} 个被内置项覆盖（${names}）`,
    reloadErrors: (n: number): string => `${n} 个错误 —— 详见日志`,
    reloadedCard: (loaded: number, ms: number, tail: string): string =>
      `已重新加载 ${loaded} 个自定义智能体，用时 ${ms}ms${tail}`,
    unknownSubcommand: (arg: string): string =>
      `未知子命令 “${arg}”。请试试 /agents 或 /agents reload。`,
    headerCount: (n: number): string => `${n} 个智能体`,
    pickerFooter: "委派：/agent <name> <task> · ↑↓ 导航 · ⌃a/⌃e 顶部/底部 · enter/esc 关闭",
  },

  agentCmd: {
    disabled: "子智能体已在设置中停用。",
    usage: "用法：/agent <名称> <任务>",
    unknownAgent: (name: string): string => `未知子智能体 "${name}"。可用：`,
    usageWithName: (name: string): string => `用法：/agent ${name} <任务>`,
  },

  clear: {
    alreadyFresh: (id: string): string => `已经在全新会话 ${id} 上了`,
    startedFresh: (id: string): string => `已启动新会话 ${id}`,
  },

  cmdList: {
    reloaded: (files: number, skills: number, ms: number, tail: string): string =>
      `已重新加载 ${files} 个文件命令、${skills} 个技能，用时 ${ms}ms${tail}`,
    reloadErrors: (errors: number): string => ` · ${errors} 个错误 —— 详见日志`,
    unknownSubcommand: (arg: string): string =>
      `未知子命令 "${arg}"。请使用 /commands 或 /commands reload。`,
    noneRegistered: "没有已注册的命令。",
    count: (n: number): string => `${n} 条命令`,
  },

  compact: {
    nothingToCompact: "没有可压缩的内容（历史为空）。",
    compacting: "正在压缩",
    blocked: (reason?: string): string =>
      `压缩被 PreCompact 钩子阻止${reason ? `：${reason}` : ""}`,
    completed: (seconds: string, before: number, after: number): string =>
      `${seconds}s · 上下文 ${before} → ${after} 条消息`,
    failedTitle: "/compact 失败",
  },

  contextView: {
    labelSystemPrompt: "系统提示词",
    labelMemoryFiles: "记忆文件",
    labelSkills: "技能",
    labelTools: "工具",
    labelMcpTools: "MCP 工具",
    labelMessages: "消息",
    labelFreeSpace: "剩余空间",
    labelAutocompactBuffer: "自动压缩缓冲区",
  },

  diff: {
    notGitRepo: "不是 git 仓库。",
    matchingScope: (pathspec: string): string => `（匹配 "${pathspec}"）`,
    cleanTree: (scope: string): string => `工作区干净 —— 没有改动${scope}。`,
    changedFiles: (n: number): string => `${n} 个文件有改动：`,
    listFooter: "↑↓ 导航 · enter 查看 diff · esc 关闭",
    noTextualDiff: "没有文本 diff（二进制文件或内容无变化）。",
    viewerFooter: "↑↓/PgUp/PgDn 滚动 · g/G 顶部/底部 · enter/esc/q 返回列表",
    untracked: "未跟踪",
    staged: (word: string): string => `已暂存的${word}`,
    unstaged: (word: string): string => `未暂存的${word}`,
    statusWord: (letter: string): string => {
      const words: Record<string, string> = {
        M: "修改",
        A: "新增",
        D: "删除",
        R: "重命名",
        C: "复制",
        T: "类型变更",
        U: "冲突",
        "?": "未跟踪",
      };
      return words[letter] ?? letter;
    },
  },

  lsp: {
    disabled: "LSP 已禁用（settings.lsp.enabled = false）。",
    noneConfigured: "未配置语言服务器。",
    running: "● 运行中",
    installed: "○ 已安装",
    notInstalled: "● 未安装",
    summary: (installed: number, total: number, running: number): string =>
      `已安装 ${installed}/${total} · 运行中 ${running}`,
    missingNote: "缺失的服务器需自行安装到 PATH（Nova 不会代为安装）",
  },

  loop: {
    usage: "用法：/loop <间隔> <提示词|/命令>  ·  /loop stop  ·  间隔如 30s、5m、1h",
    loopingEvery: (every: string, n: number, max: number): string =>
      `每 ${every} 循环一次（${n}/${max}）`,
    stopped: "循环已停止",
    noActive: "没有活跃的循环",
    invalidInterval: (interval: string): string =>
      `无效的间隔 "${interval}" —— 期望如 30s、5m、1h。`,
    missingPayload: "缺少要循环的提示词或命令。",
    intervalTooShort: (min: string): string =>
      `间隔太短 —— 最小为 ${min}（settings.loop.minIntervalMs）。`,
    noSelfNesting: "不能在循环中运行 /loop 作为 payload。",
    startedCard: (replaced: boolean, interval: string, max: number): string =>
      `${replaced ? "已替换循环 —— " : ""}立即运行，此后每轮完成后每 ${interval} 运行一次` +
      `（最多 ${max} 次）。/loop stop 可停止。`,
  },

  resume: {
    noSessions: "没有可恢复的会话。",
    notFound: (id: string): string => `未找到会话 ${id}。`,
    header: "选择要恢复的会话：",
    alreadyOn: "已经在该会话上了。",
  },

  skills: {
    disabled: "技能已在设置中禁用。",
    none: "未找到技能。",
    count: (n: number): string => `${n} 个技能`,
  },

  usage: {
    noRequests: "本次会话尚无模型请求。",
    cacheHitRate: "缓存命中率",
    cacheHitRateHint: "（缓存读取 / 全部提示词 token）",
    promptTokens: "提示词 token",
    cacheRead: "  缓存读取",
    cacheWrite: "  缓存写入",
    uncached: "  未缓存",
    outputTokens: "输出 token",
    costEst: "成本（估算）",
    noPrice: (model: string): string =>
      `没有 "${model}" 的价格 —— 请在 nova.config.json 中为该模型层级添加 "pricing"`,
  },

  rewind: {
    nothingToRewind: "没有可回退的内容。",
    expectedTurnCount: (count: number): string => `需要一个轮次数（1-${count}）。`,
    onlyNTurns: (count: number): string => `只有 ${count} 个用户轮次可供回退。`,
    pickerHeader: "回退到哪条消息？其后的所有内容都会被丢弃：",
    restoreHeader: (modify: number, remove: number): string =>
      `将恢复 ${modify} 个文件，删除 ${remove} 个新建文件：`,
    noneRevertable: "没有文件可自动回退（均在 nova 之外被改动）：",
    conflictNote: (count: number): string =>
      `自那一轮以来有 ${count} 个文件在 nova 之外被改动 —— 已保留不动，以免覆盖较新的改动：`,
    confirmFooter: "←→ 导航 · enter 确认 · esc 取消",
    restoreAndRewind: "恢复并回退",
    rewindHistoryOnly: "仅回退历史",
    cancel: "取消",
    cancelledNothingChanged: "已取消；未做任何更改。",
    restoreFailed: (msg: string): string => `文件恢复失败：${msg}`,
    fileNote: (count: number): string => ` 已恢复 ${count} 个文件。`,
    skipNote: (count: number): string => ` 跳过了 ${count} 个在 nova 之外被改动的文件。`,
    rewoundSummary: (p: {
      turn: number;
      dropped: number;
      fileNote: string;
      skipNote: string;
    }): string =>
      `已回退到第 #${p.turn} 轮；丢弃了 ${p.dropped} 条消息。${p.fileNote}${p.skipNote} ` +
      `你的消息已回到输入框（→ 可编辑）。`,
  },

  goal: {
    noActiveGoal: "没有活跃的目标。",
    setOneWith: "设置方式",
    activeGoal: "活跃目标：",
    autoContinuations: (n: number, max: number): string => `自动续跑：${n}/${max}`,
    noGoalToClear: "没有可清除的活跃目标。",
    cleared: "已清除目标：",
    disabled: "目标模式已禁用（settings.goal.enabled = false）。",
    set: "目标已设置：",
    setHelp: "Nova 将立即开始推进此目标，并在每轮结束后重新检查直至达成。" +
      "运行 /goal clear 可停止。",
  },

  help: {
    sectionBuiltin: "内置",
    sectionProject: "项目",
    sectionUser: "用户",
    sectionSkill: "技能",
    sectionMcp: "MCP",
    sectionPlugin: "插件",
    pasteHint: "粘贴图片（Cmd/Ctrl+V）或拖入文件 —— 会作为模型可读取的路径插入。",
    leaveHint: "Ctrl+D 或 /exit 退出。/commands 列出全部；/commands reload 重新扫描文件。",
    commandCount: (n: number): string => `${n} 条命令`,
    navFooter: "↑↓ 导航 · ⌃a/⌃e 顶部/底部 · enter/esc 关闭",
  },

  hooks: {
    autoCompact: (before: number, after: number): string => `上下文 ${before} → ${after} 条消息`,
    autoCompactTitle: "自动压缩",
    requestFailed: (word: string, seconds: string, error: string): string =>
      `${word} · ${seconds}s · ${error}`,
    requestFailedTitle: "请求失败",
    loopTerminated: (message: string, logPath: string): string => `${message}\n详见日志：${logPath}`,
    loopTerminatedTitle: "循环已终止",
  },

  input: {
    history: (pos: number, total: number): string => ` 历史 ${pos}/${total} `,
    moreQueued: (n: number): string => ` ↳ 还有 ${n} 条排队`,
    moreAbove: (n: number): string => `还有 ${n} 条`,
  },

  setup: {
    tagline: "专为 DeepSeek 打造的编程智能体 —— 95%+ 缓存命中 · 系统级沙箱 · 工具齐备",
    welcome: "欢迎使用 Nova！",
    missing: (n: number): string => `还缺 ${n} 项设置 —— 我们来配置一下。（Ctrl+C 取消）`,
    configSavedTo: (path: string): string => `配置将保存到：${path}`,
    noteBaseURL: "注意：baseURL 必须指向兼容 Anthropic 的 API 端点。",
    providerQuestion: "你要连接哪个服务商？",
    providerFooter: "↑/↓ 选择 · Enter 确认 · Ctrl+C 取消",
    otherProvider: "其他服务商",
    recommended: "★ 推荐",
    beta: "Beta",
    aborted: "已取消设置。",
    apiKeyLabel: "API 密钥",
    apiKeyEmpty: "✗ API 密钥不能为空",
    saved: (label: string): string => `✓ 已保存 ${label} 设置`,
    manualIntro: (path: string): string => `要使用其他服务商，请在此创建配置文件：${path}`,
    manualShape: "配置结构如下：",
    manualRerun: "然后重新运行 nova。",
  },

  ask: {
    other: "其他",
    otherDesc: "输入自定义答案",
    confirm: "确认",
    reviewSubmit: "检查你的答案并提交。",
    noAnswer: "（未作答）",
    submit: "提交",
    cancel: "取消",
    answerAllFirst: "  （请先回答所有问题）",
    freeformHint: "输入自定义答案，Enter 确认，Esc 取消",
    navTab: "←/→ 标签",
    navButton: "↑/↓ 按钮",
    navOption: "↑/↓ 选项",
    navToggle: "空格切换",
    navFreeform: "enter 确认 · esc 取消",
    navActivate: "enter 激活",
    navNext: "enter 下一个",
    navCancel: "ctrl+c 取消",
  },

  trust: {
    question: "你信任此文件夹中的文件吗？",
    lines: [
      "nova 尚未获得访问此文件夹的权限。授予访问权限后，",
      "它可以读取和编辑此处（及子目录）的文件而无需",
      "每次确认，并会运行该文件夹定义的任何项目钩子。",
      "只信任你认识的文件夹 —— 拒绝将直接退出，不改动",
      "任何内容。",
    ],
    footer: "↑/↓ 选择 · Enter 确认 · Ctrl+C 退出",
    yes: "是，信任此文件夹",
    no: "否，退出",
    exiting: (path: string): string => `未信任工作区 —— 正在退出。\n  ${path}`,
    persistFailed: (msg: string): string => `无法持久化工作区信任：${msg}`,
    persistFailedTitle: "工作区信任",
  },
};
