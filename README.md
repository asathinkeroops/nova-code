<div align="center">

<img src="docs/app-icon-v2.webp" alt="NOVA-CODE" width="200">

<h1>NOVA&nbsp;CODE</h1>

<p><b>为 DeepSeek 量身打造的终端编程代理</b></p>

<p><code>95%+ 缓存命中</code> · <code>OS 级沙箱</code> · <code>工具齐全</code> · <code>开箱即用</code></p>

<p>
  <a href="https://www.npmjs.com/package/@asathinkeroops/nova-code"><img src="https://img.shields.io/npm/v/@asathinkeroops/nova-code?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=CB3837" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node ≥ 20">
  <img src="https://img.shields.io/badge/Built_for-DeepSeek-4D6BFE?style=for-the-badge&logoColor=white" alt="Built for DeepSeek">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="MIT 许可证"></a>
</p>

<p>
  <b>简体中文</b>
  &nbsp;·&nbsp;
  <a href="README.en-US.md">English</a>
</p>

<p>
  <a href="#-为什么选-nova"><b>为什么选</b></a>
  &nbsp;•&nbsp;
  <a href="#-快速开始"><b>快速开始</b></a>
  &nbsp;•&nbsp;
  <a href="#-功能概览"><b>功能概览</b></a>
  &nbsp;•&nbsp;
  <a href="#-架构"><b>架构</b></a>
  &nbsp;•&nbsp;
  <a href="#-开发"><b>开发</b></a>
</p>

<br>

<img src="snapshots/screen.png" alt="Nova 截图" width="100%">

<br><sub>💬 读代码、跑命令、改文件 —— 一个终端里把任务推到完成</sub>

</div>

<br>

Nova 读代码、跑命令、改文件 —— 通过工具调用把任务推到完成。模型层围绕 **DeepSeek** 构建：thinking 映射到 effort（而非 `budget_tokens`）、错误码翻成人话、余额与定价内建，整个请求管线为 DeepSeek 的自动上下文缓存做了调优，让缓存持续命中。各家 provider 都走 Anthropic 兼容协议，差异（thinking 形状、错误码、余额探针）由 **provider profile**（按 `settings.provider` 选择）吸收 —— DeepSeek 是第一优先级，Kimi（Moonshot）有专用适配（beta），其余端点走通用 `other` 档。

<br>

## ✨ 为什么选 Nova

<table>
<tr>
<td width="50%" valign="top">

### ⚡ DeepSeek 原生适配，零配置

不用调 `cache_control`、不用翻错误码文档。装好，填 key，开干。thinking 映射到 DeepSeek 的 `effort`（不是 `budget_tokens`）、HTTP 错误码翻成人话、状态行实时显示账户余额 —— 全部围绕 DeepSeek 调过，开箱即用。

</td>
<td width="50%" valign="top">

### 🎚️ 不止 DeepSeek：多 provider，三档阶梯

内置 DeepSeek、Moonshot（Kimi）、通用 Anthropic 兼容三套 provider profile，各带错误码表、限流重试与余额探测。模型按 `lite` / `pro` / `max` 三档配置，每档独立设 id、thinking 等级和定价；`/model`、`--model` 切的是档位而非裸 provider id。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🚀 缓存友好刻在骨子里

历史 append-only，请求体逐字节稳定（内部 `meta` 字段发送前剥除，不污染前缀），记忆与 skills 只在会话边界重建、绝不中途变动 —— 让 DeepSeek 的服务端前缀缓存每轮命中，响应更快、token 更省。auto 压缩默认在上下文用到窗口一半时触发，且只追加一条 `<compacted>` 边界。

</td>
<td width="50%" valign="top">

### 🔒 OS 级沙箱，一行开启

开启后，子进程（`bash` / 后台任务）的文件写入被 OS 级沙箱限制在工作区（macOS Seatbelt / Linux bubblewrap），叠在权限引擎之上；只拦写入，读取与网络默认放行。默认关闭，`sandbox.enabled: true`（或会话内 `/sandbox on`）即开；不支持的平台静默降级。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧩 用 Markdown 扩展，用插件分发

自定义子 agent、slash 命令、skills、生命周期 hooks —— 一个 `.md` 文件、frontmatter 写配置、正文写指令，即刻生效。想整包分享就装进插件：`nova plugin install` 从本地路径、GitHub、git url 或 marketplace 安装，兼容 Claude Code 的插件格式。

</td>
<td width="50%" valign="top">

### 🤖 为自动化而生

`nova -p` 无头模式单轮跑完即退，配 `--output-format json` 就能接进脚本与 CI；`/review <PR#>` 走 `gh` 只读评审 GitHub PR；`cronCreate` 按间隔或 cron 表达式定时触发 prompt；`/goal` 设定成功条件后自动推进直到达成。

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 🔄 使用习惯无缝迁移

高度复刻 Claude Code 的交互方式 —— 同样的 slash 命令、快捷键、审批弹窗、三层记忆文件、可重放会话。用过 Claude Code 就零学习成本：装好继续按原有习惯干活，只是底层换成了为 DeepSeek 量身调优的引擎。

</td>
</tr>
</table>

<br>

## 🚀 快速开始

> [!NOTE]
> 环境要求：**Node ≥ 20**

```bash
npm install @asathinkeroops/nova-code -g
nova                               # 启动 REPL
nova -p "解释这段代码"              # headless 模式：只跑一轮，输出后退出
nova upgrade                       # 更新到最新版本（启动时也会自动检查并提示）
```

首次启动进入交互式配置向导，写入 `~/.nova/nova.config.json`（API key、模型、session 目录等）；不想让 key 明文落盘时，导出环境变量 `NOVA_API_KEY` 即可——它优先于配置文件里的 `apiKey`。模型按 `lite` / `pro` / `max` 三档配置，每档可单独设定 thinking 等级与定价（`models.<档>.pricing`，支持 USD / CNY）；`/model`、`--model` 切换的是档位而非裸 provider id。默认 provider 为 `deepseek`，`settings.provider` 可切到 `moonshot`（Kimi，beta）或通用 `other`。界面与回复语言由 `settings.language`（模型回复语言，默认跟随系统 locale）与 `settings.locale`（仅 TUI 静态文案，内置 zh-CN / EN）分别控制。

### 📦 更多子命令

| 子命令 | 作用 |
| --- | --- |
| `nova doctor` | 体检全局配置 |
| `nova mcp` | 管理 MCP 服务器 |
| `nova plugin` | 安装 / 启停插件 |
| `nova upgrade` | 升级 CLI |

<br>

## 🛠️ 功能概览

### 内置工具

模型能调用的工具，覆盖读写、搜索、执行、代码智能、联网：

| 工具 | 能力 |
| --- | --- |
| `read` / `write` / `edit` | 读文件（行号 + 分页，支持 `.xlsx` / `.ods` 表格与 `.pdf` 文档；图片需模型档位支持图像输入）、整文件写、精确文本替换 |
| `glob` / `grep` | 按文件名匹配、全文正则搜索 |
| `bash` | 运行 shell 命令；`run_in_background: true` 则把 dev server、watcher 等长任务放到后台，立即返回 id、pid 和日志路径 |
| `killBackground` | 终止一个后台命令 |
| `monitor` / `stopMonitor` | 监听脚本：stdout 每一行变成一条通知（`tail -f`、watcher、轮询循环） |
| `lsp` | 代码智能：定义跳转、引用查找、hover、diagnostics、符号搜索 |
| `webfetch` / `websearch` | 抓取网页、联网搜索 |
| `createTodo` / `updateTodo` / `getTodoList` / `clearTodoList` | 会话内多步清单 |
| `createTask` / `updateTask` / `getTaskList` / `clearTaskList` | 跨会话任务计划，支持依赖 |
| `askUserQuestion` | 向用户提多选问题并等待作答 |
| `enterPlanMode` / `exitPlanMode` | 模型自己进入只读的 plan 模式先出方案；方案写好后请用户确认才退出并动手。就算模型忘了调 `exitPlanMode`，一轮结束时 nova 也会自己弹确认框，同意即恢复原权限档并接着实现 |
| `cronCreate` / `cronList` / `cronDelete` | 按间隔或 cron 表达式定时跑 prompt 或 `/命令`；会话内生效，`/resume` 后自动重挂 |
| `loadSkill` | 按需加载 skill |

### ⌨️ 内置命令

| 命令 | 能力 |
| --- | --- |
| `/help` | 查看所有命令 |
| `/model` · `/effort` | 切换模型档位（lite/pro/max）、调整思考等级 |
| `/compact` | 压缩长历史成摘要 |
| `/clear` · `/resume` · `/rewind` | 开新会话、恢复历史会话、回退历史 |
| `/rename` | 给当前会话起个名字（显示在输入框边框上） |
| `/plan` | 只读调研出实现方案，不动手 |
| `/goal` | 设定成功条件后自动推进直到达成 |
| `/diff` · `/review` | 浏览、评审未提交改动；`/review <PR#\|#PR\|github-pr-url>` 经 `gh` 只读评审指定 GitHub PR |
| `/init` | 分析代码库生成 `NOVA.md` |
| `/agents` · `/agent` | 查看子 agent 类型、委派任务 |
| `/nova-code-guide` · `/nova-code-guide-update` | 就 Nova 自身答疑的只读 Q&A agent；后者拉取最新源码 |
| `/commands` · `/skills` · `/mcp` · `/lsp` · `/plugin` | 查看已注册命令、skills、MCP 服务器、语言服务器、已加载插件 |
| `/sandbox` | 本会话内开关 OS 命令沙箱（`on` / `off`） |
| `/loop` | 按间隔重复跑某条 prompt 或命令（`/loop <间隔> <prompt\|/cmd>`，`/loop stop` 停止） |
| `/doctor` | 体检全局配置（JSON/schema、模型/key、hooks、MCP），报告问题，可交给 agent 就地修复 |
| `/usage` · `/context` | 查看 token 用量、缓存命中、上下文占用 |
| `/tasks` | 查看和管理后台命令（`bash` + `run_in_background`），支持 list / stop |
| `/predict` | 开关下一条输入预测 |
| `/exit` · `/quit` | 退出 |

### 核心特性

| 特性 | 能力 |
| --- | --- |
| 🧠 子 agent | 带全新上下文、独立工具集干活：`explore` 只读检索、`plan` 只读规划、`general-purpose` 全权限、`nova-code-guide` 答疑，可自定义；每个 agent 可经 `subagent.model` 单独指定模型档位 |
| 🛡️ 权限与沙箱 | <kbd>shift</kbd>+<kbd>tab</kbd> 切换 `default` / `acceptEdits` / `auto` / `plan`（模型也能自己进 plan 模式；退出必须经你确认，且这道确认由 nova 在回合结束时主动弹，不靠模型自觉）；OS 级沙箱把子进程写入隔离在工作区（macOS Seatbelt / Linux bubblewrap），默认关闭、可一键开启 |
| 📄 文件防护 | 改文件前强制先读、检测外部改动，避免误覆盖 |
| 🔌 MCP | 接入外部 MCP 服务器（`stdio` / `http` / `sse`），把它们的工具当内置工具用，同样受权限管控 |
| 📚 Skills | 把可复用操作手册写成 `SKILL.md`，模型按需加载，省 token 又能随仓库分发 |
| 📝 Markdown 扩展 | 自定义 slash 命令、子 agent、生命周期 hooks，丢 `.md` 进 `.nova/`、frontmatter 配置，免改代码 |
| 🧩 插件 | `nova plugin` 从本地路径 / GitHub / git url / marketplace 安装、启停插件；一个插件可贡献命令、agent、skill、hooks、MCP / LSP server 与 `bin/` 可执行文件，兼容 Claude Code 插件格式 |
| 🗂️ 三层记忆 | 全局 → 用户 → 项目，按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 优先级加载 |
| 💻 交互体验 | 全屏 Ink/React REPL，流式输出 + 鼠标；`@path` / `/` 补全、<kbd>↑</kbd> <kbd>↓</kbd> 翻历史；实时状态行显示 token 用量、缓存命中、花费、provider 余额（DeepSeek / Kimi）、git 分支、上下文占用 |
| 🌐 多语言 | 界面与模型回复语言分开配置：`settings.language` 控制模型回复语言（默认跟随系统 locale），`settings.locale` 单独覆盖 TUI 静态文案（内置 zh-CN / EN），二者可不同（如中文界面 + 英文回复）；不支持的语言标签回落到英文 |

<br>

## 🏗️ 架构

Nova 的核心是一个模型循环（`agentLoop`），只有**一个扩展点** —— 类型化的 `HookRegistry`。权限闸门、上下文压缩、transcript 写入、UI 刷新都以 hook 的形式挂在具名生命周期点上；`@nova/core` 本身不导入任何模型 SDK、工具实现或 UI。阻塞型 hook（◆）可改写 / 否决某一步，通知型 hook（○）只观察。

<div align="center">
  <img src="docs/agent-loop.svg" alt="Nova agent loop 与 hook 机制" width="100%">
</div>

### 📁 仓库结构

```
packages/
  core           agent loop · model client · HookRegistry · message/stop-reason 类型
  agent          createAgent：按 turn 跑的驱动 + 持久化 + transcript 接线
  runtime        settings (zod) · pino logger · session 存储
  tools          ToolRegistry · dispatcher · 内置工具
  subagent       createSubAgent 工具 · 子 agent 定义/注册表/加载器
  context        三层记忆（NOVA.md > CLAUDE.md > AGENTS.md）· auto compact
  safety         PermissionEngine · approval 提示
  sandbox        OS 级命令沙箱（文件写入隔离）
  lsp            LSP 客户端/管理器（JSON-RPC over stdio）
  external       SlashRegistry · .md 命令加载 · MCP 客户端
  observability  Transcript (JSONL)
apps/
  cli            `nova` 二进制入口（Ink/React REPL，唯一在跑的应用）
  http, vscode   占位，未实现
eval/            replay harness + 黄金 case（不走主构建）
docs/            设计笔记 & 使用手册
```

依赖方向单向不可逆：`runtime` / `core` / `observability` / `lsp` 是叶子层（不 import `@nova/*` 源码）；`safety` → `runtime`；`context` → `core` + `runtime`；`tools` → `core` + `runtime` + `lsp`；`sandbox` / `external` → `core`（type-only）；`agent` → `core` + `runtime` + `context` + `observability`；`subagent` → `agent` + `context` + `core` + `observability` + `runtime`；`cli` 在最上层，依赖以上全部。

<br>

## 👩‍💻 开发

```bash
pnpm build                 # 全量构建（tsup，递归）
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest run
pnpm test:watch
pnpm vitest run path/to/file.test.ts
pnpm vitest run -t "name"
pnpm lint / pnpm lint:fix
pnpm format / pnpm format:check
```

单包脚本：`pnpm --filter @nova/<name> <script>`。测试文件和源码并排放：`packages/*/src/**/*.test.ts(x)`。

新贡献者请先读：
- `CLAUDE.md` — 架构约定、loop 契约、ESM 规范
- `nova-architecture.html` — 架构总图

<br>

---

<div align="center">

### 🧰 技术栈

<p>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js_20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20">
  <img src="https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/Ink_·_React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="Ink / React">
  <img src="https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
  <img src="https://img.shields.io/badge/zod-3E67B1?style=flat-square&logo=zod&logoColor=white" alt="zod">
</p>

<br>

## 📜 License

[MIT](LICENSE) © Nova contributors.

<p>
  <a href="https://github.com/asathinkeroops/nova-code">🏠 仓库</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/asathinkeroops/nova-code/issues">🐛 反馈问题</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@asathinkeroops/nova-code">📦 npm</a>
</p>

<sub>为 DeepSeek 量身打造 ❤️</sub>

<br><br>

<sub>如果 Nova 帮到了你，欢迎点一个 ⭐ Star</sub>

</div>
