<div align="center">

<img src="docs/app-icon-v2.webp" alt="NOVA-CODE" width="200">

<h1>NOVA&nbsp;CODE</h1>

<p><b>面向国产大模型的 Claude Code</b></p>

<p>开箱即用的成品，不是拼装框架；同样的任务，token 花得最少。</p>

<p><code>高缓存命中率</code> · <code>OS 级沙箱</code> · <code>工具齐全</code> · <code>开箱即用</code></p>

<p>
  <a href="https://www.npmjs.com/package/@asathinkeroops/nova-code"><img src="https://img.shields.io/npm/v/@asathinkeroops/nova-code?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=CB3837" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node ≥ 20">
  <img src="https://img.shields.io/badge/Built_for-Chinese_LLMs-4D6BFE?style=for-the-badge&logoColor=white" alt="Built for Chinese LLMs">
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
  <a href="docs/guide.md"><b>使用手册</b></a>
  &nbsp;•&nbsp;
  <a href="#-开发"><b>开发</b></a>
</p>

<br>

<img src="snapshots/screen.png" alt="Nova 截图" width="100%">

<br><sub>💬 读代码、跑命令、改文件 —— 一个终端里把任务推到完成</sub>

</div>

<br>

Nova 读代码、跑命令、改文件 —— 通过工具调用把任务推到完成。它是**开箱即用的成品**，不是需要自己拼装的框架：权限、工作区信任、沙箱、LSP、MCP、Skills、插件、可恢复会话都已就位，装好填 key 就能干活。

模型接入由两个正交维度组成：**供应商适配（`provider`）**负责 thinking 形状、错误翻译、重试与余额探测，**传输协议（`transport`）**负责 Anthropic Messages 或 OpenAI `chat/completions` wire。当前首启向导默认接入 DeepSeek 的 OpenAI 兼容端点；同一个 DeepSeek profile 也能切到 `/anthropic`，而 Kimi / Qwen / GLM / MiniMax / 豆包等端点可通过内置 profile 或手动配置接入。整个请求管线围绕服务端自动前缀缓存设计，让重复上下文复用更多、token 花得更少。

<br>

## ✨ 为什么选 Nova

<table>
<tr>
<td width="50%" valign="top">

### ⚡ 双协议原生适配，开箱即用

不用调 `cache_control`、不用翻错误码文档。装好，填 key，开干。thinking 按协议和供应商映射：DeepSeek 的 Anthropic wire 使用 `output_config.effort`，OpenAI wire 使用 `thinking.type` + `reasoning_effort`，Kimi 的 Anthropic wire 使用 `thinking.type`；HTTP 错误会翻成人话并附上充值 / 建 key 链接。DeepSeek / Qwen / GLM / MiniMax / 豆包等 `chat/completions` 端点走原生 OpenAI 传输，供应商的错误翻译与余额探针不会因换协议丢失。

</td>
<td width="50%" valign="top">

### 🎚️ 多 provider，三档阶梯

内置 DeepSeek、Moonshot（Kimi，beta）和通用 Anthropic 兼容（`other`）三套 provider profile，各带错误码表与限流重试（DeepSeek / Kimi 另带余额探测）；当前首次配置向导只开放 DeepSeek，其余端点可手动配置。OpenAI 兼容端点通过 `transport: "openai"` 复用现有供应商 profile，不另造 provider。模型按 `lite` / `pro` / `max` 三档配置，每档独立设 id、thinking、模态、上下文窗口与定价。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🚀 缓存友好刻在骨子里

历史 append-only，请求体逐字节稳定（内部 `meta` 字段发送前剥除，不污染前缀），记忆与 skills 只在会话边界重建、绝不中途变动 —— 尽可能让服务端自动前缀缓存跨轮复用（DeepSeek、Kimi 均为此类缓存），响应更快、token 更省。auto 压缩默认在上下文用到窗口一半时触发，且只追加一条 `<compacted>` 边界。

</td>
<td width="50%" valign="top">

### 🔒 OS 级沙箱，一行开启

开启后，子进程（`bash` / 后台任务）的文件写入被 OS 级沙箱限制在工作区（macOS Seatbelt / Linux bubblewrap），叠在权限引擎之上；只拦写入，读取与网络默认放行。默认关闭，`sandbox.enabled: true`（或会话内 `/sandbox on`）即开；不支持的平台静默降级。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧩 用 Markdown 扩展，用插件分发

自定义子 agent、slash 命令和 skills 都用 Markdown 声明；生命周期 shell hooks 则写进全局配置或项目的 `.nova/hooks.json` / `.nova/hooks.local.json`。想整包分享就装进插件：`nova plugin install` 支持本地路径、GitHub、git URL 或 marketplace，兼容 Claude Code 插件格式。

</td>
<td width="50%" valign="top">

### 🤖 为自动化而生

`nova -p` 无头模式单轮跑完即退，非 TTY 时还能从 stdin 自动读取 prompt；`--output-format json|jsonl` 输出完整结果或流式事件，便于接入脚本、CI 与 git hooks。`/review <PR#>` 通过 `gh` 只读评审 GitHub PR；`cronCreate` 定时触发 prompt；`/goal` 按成功条件自动推进。

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 🔄 使用习惯无缝迁移

高度复刻 Claude Code 的交互方式 —— 同样的 slash 命令、快捷键、审批弹窗、三层记忆文件、可重放会话。用过 Claude Code 就零学习成本：装好继续按原有习惯干活，只是底层换成了为国产大模型调优、按 token 成本设计的引擎。

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
nova "解释这个仓库的架构"           # 先跑一条 prompt，再留在 REPL
nova -p "解释这段代码"              # headless 模式：只跑一轮，输出后退出
echo "总结当前 diff" | nova --output-format jsonl
nova upgrade                       # 更新到最新版本（启动时也会自动检查并提示）
```

首次启动目前会直接询问 DeepSeek API key，并把一个 provider 连接（`providers: [{ "name": "deepseek", "profile": "deepseek", "transport": "openai", "baseURL": "https://api.deepseek.com", "apiKey": "<key>" }]` 与 `currentProvider: "deepseek"`）和默认档位 `pro` 写入 `~/.nova/nova.config.json`。不想让 key 明文落盘时，可导出 `NOVA_API_KEY`；它优先于当前 provider 连接的 `apiKey`，向导也不会把环境变量中的 key 写回磁盘。首次进入一个工作区时还会要求确认信任，信任记录只保存在用户全局配置中。

运行时只接受 `providers` / `currentProvider` 结构。检测到旧的顶层 `provider`、`baseURL`、`apiKey`、`models`、`transport` 时，启动会先把它们一次性迁移成 provider 连接并原子写回配置文件；后续只按新格式读取。

Headless 模式不会运行交互向导；当前 provider 缺少 API key、解析不到模型表，或缺少协议所需的 `baseURL` 时会直接报错。请先交互启动一次完成配置，或手动补齐 `providers` / `currentProvider`。

DeepSeek 的内置模型梯度是 `lite` → `deepseek-v4-flash-vision-exp`（支持图片输入），`pro` / `max` → `deepseek-v4-pro`，三档分别使用不同 thinking 深度。**默认模型表按 provider 内置在代码里，不写进配置文件**；你的配置只保存覆盖项，因此升级即可获得新的模型 id、价格和上下文窗口。`/model` 持久切换档位，`--model` 只覆盖本次启动；界面与回复语言分别由 `settings.locale`（TUI，内置 zh-CN / EN）和 `settings.language`（模型回复，默认跟随系统 locale）控制。更多 provider 与完整配置见[使用手册](docs/guide.md)。

### 📦 更多子命令

<!-- prettier-ignore -->
| 子命令 | 作用 |
| --- | --- |
| `nova doctor` | 体检全局配置 |
| `nova mcp` | 添加、查看、移除 MCP 服务器并管理远程 OAuth 登录 |
| `nova plugin` | 安装、卸载、启停插件并管理 marketplace |
| `nova upgrade` | 升级 CLI |

<br>

## 🛠️ 功能概览

### 内置工具

模型能调用的工具覆盖读写、搜索、执行、代码智能与联网。最终工具集会按配置、已发现的 Skills / LSP / MCP 能力和 `permissions.deny` 动态生成：

<!-- prettier-ignore -->
| 工具 | 能力 |
| --- | --- |
| `read` / `write` / `edit` | 读文件（行号 + 分页，支持 `.xlsx/.xls/.xlsm/.xlsb/.ods` 表格与 `.pdf` 文档）、整文件写、精确文本替换；图片通过 Anthropic / OpenAI 两种传输都可用的用户图片消息交给支持视觉的档位（最长边超过 2048px 时先在内存中等比缩小，不改写原文件） |
| `glob` / `grep` | 按文件名匹配、全文正则搜索 |
| `bash` | 运行 shell 命令；`run_in_background: true` 则把 dev server、watcher 等长任务放到后台，立即返回 id、pid 和日志路径 |
| `killBackground` | 终止一个后台命令 |
| `monitor` / `stopMonitor` | 监听脚本：stdout 每一行变成一条通知（`tail -f`、watcher、轮询循环） |
| `lsp` | 代码智能：定义跳转、引用查找、hover、diagnostics、符号搜索 |
| `webfetch` / `websearch` | 抓取网页、联网搜索 |
| `createTodo` / `updateTodo` / `getTodoList` / `clearTodoList` | 会话内多步清单 |
| `createTask` / `updateTask` / `getTaskList` / `clearTaskList` | 跨会话任务计划，支持依赖 |
| `askUserQuestion` | 向用户提多选问题并等待作答 |
| `createSubAgent` | 委派一个有独立上下文和工具集的 `explore` / `plan` / `general-purpose` 或自定义子 agent |
| `enterPlanMode` / `exitPlanMode` | 模型自己进入只读的 plan 模式先出方案；方案写好后请用户确认才退出并动手。就算模型忘了调 `exitPlanMode`，一轮结束时 nova 也会自己弹确认框，同意即恢复原权限档并接着实现 |
| `cronCreate` / `cronList` / `cronDelete` | 按间隔或 cron 表达式定时跑 prompt 或 `/命令`；会话内生效，`/resume` 后自动重挂 |
| `loadSkill` | 按需加载 skill |

### ⌨️ 内置命令

<!-- prettier-ignore -->
| 命令 | 能力 |
| --- | --- |
| `/help` | 查看所有命令 |
| `/model` · `/effort` | 持久切换模型档位、调整当前档位的思考等级；显式数字 budget 仅本会话生效 |
| `/compact` | 压缩长历史成摘要 |
| `/clear` · `/resume` · `/rewind` | 开新会话、恢复当前 workspace 的历史会话；回退历史时预览并恢复 Nova 的文件快照，外部改动会作为冲突保留 |
| `/rename` | 给当前会话起个名字（显示在输入框边框上） |
| `/plan` | 只读调研出实现方案，不动手 |
| `/goal` | 设定成功条件后自动推进直到达成 |
| `/diff` · `/review` | 浏览、评审未提交改动；`/review <PR#\|#PR\|github-pr-url>` 经 `gh` 只读评审指定 GitHub PR |
| `/init` | 分析代码库生成 `NOVA.md` |
| `/agents` · `/agent` | 查看子 agent 类型、委派任务 |
| `/nova-code-guide` · `/nova-code-guide-update` | 就 Nova 自身答疑的只读 Q&A agent；后者拉取最新源码 |
| `/commands` · `/skills` · `/lsp` | 查看或重载命令、查看 skills 与语言服务器 |
| `/mcp` · `/plugin` | MCP 菜单可鉴权、重连、退出登录和查看工具；插件菜单查看本会话已加载贡献（安装 / 启停走 `nova plugin`） |
| `/sandbox` | 本会话内开关 OS 命令沙箱（`on` / `off`） |
| `/loop` | 按间隔重复跑某条 prompt 或命令（`/loop <间隔> <prompt\|/cmd>`，`/loop stop` 停止） |
| `/doctor` | 体检全局配置（JSON/schema、模型/key、hooks、MCP），报告问题，可交给 agent 就地修复 |
| `/usage` · `/context` | 查看 token 用量、缓存命中、上下文占用 |
| `/tasks` | 查看和管理后台命令（`bash` + `run_in_background`），支持 list / stop |
| `/predict` | 开关下一条输入预测 |
| `/exit` · `/quit` | 退出 |

每个 session 在创建时永久绑定当前 workspace。`nova -c` 和 `/resume` 只查找当前 workspace 的 session；`nova --resume <id>` 或 `/resume <id>` 遇到其他 workspace 的 session 时会拒绝恢复并提示其绑定目录。

### 核心特性

<!-- prettier-ignore -->
| 特性 | 能力 |
| --- | --- |
| 🧠 子 agent | 带全新上下文、独立工具集干活：`explore` 只读检索、`plan` 只读规划、`general-purpose` 全权限、`nova-code-guide` 答疑，可自定义；每个 agent 可经 `subagent.model` 单独指定模型档位 |
| 🛡️ 权限与沙箱 | 首次进入目录先过工作区信任门；默认 `auto` 模式以静态规则 + 可选小模型分类器判断 bash 风险，<kbd>shift</kbd>+<kbd>tab</kbd> 可切 `default` / `acceptEdits` / `auto` / `plan`；OS 级沙箱把子进程写入隔离在工作区（macOS Seatbelt / Linux bubblewrap），默认关闭、可一键开启 |
| 📄 文件防护 | 改文件前强制先读、检测外部改动，避免误覆盖 |
| 🔌 MCP | 接入 `stdio` / `http` / `sse` 服务器；工具进入统一权限门，resources 通过只读工具访问，prompts 映射成 slash 命令，远程服务器支持 OAuth 2.0 + PKCE |
| 📚 Skills | 把可复用操作手册写成 `SKILL.md`，模型按需加载，省 token 又能随仓库分发 |
| 📝 声明式扩展 | `.nova/commands/*.md`、`.nova/agents/*.md`、`.nova/skills/*/SKILL.md` 声明命令、子 agent 与 skills；`.nova/hooks.json` / `.nova/hooks.local.json` 声明生命周期 shell hooks |
| 🧩 插件 | `nova plugin` 从本地路径 / GitHub / git URL / marketplace 安装、启停插件；一个插件可贡献命令、agent、skill、hooks、MCP / LSP server 与 `bin/`，兼容 Claude Code 插件格式；插件加载默认关闭，需显式启用 |
| 🗂️ 记忆 | 静态记忆按全局 → 用户 → 项目叠加，每层按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 选一个；另有按项目隔离、跨会话持久的 agent 自动记忆 |
| 💻 交互体验 | 全屏 Ink/React REPL，流式输出 + 鼠标；`@path` / `/` 补全、`!command` shell 直通、图片粘贴 / 拖拽、<kbd>↑</kbd> <kbd>↓</kbd> 翻历史；状态行显示 token、缓存命中、provider 余额、git 分支与上下文占用 |
| 🌐 多语言 | 界面与模型回复语言分开配置：`settings.language` 控制模型回复语言（默认跟随系统 locale），`settings.locale` 单独覆盖 TUI 静态文案（内置 zh-CN / EN），二者可不同（如中文界面 + 英文回复）；不支持的语言标签回落到英文 |

<br>

## 🏗️ 架构

Nova 的内核是 `@nova/core`：模型循环（`agentLoop`）加上包在外面的 turn 生命周期。扩展它有**两种机制**，界线很清楚——**port** 是「每个 agent 恰好一个实现」的机制位（模型、system prompt、工具、历史、压缩、权限、日志、事件），**hook** 是挂在 17 个具名生命周期点上的 0..N 个订阅者，只观察或轻改。port 就是它那条 hook 链的内建首节点：`compactor.compact` 排在 `pre_compact` 之前，`permission.check` 排在 `pre_tool_use` 之前。`@nova/core` 自己不导入任何 workspace 包、模型 SDK、工具实现或 UI（由 eslint 强制）——需要什么就声明一个 port，交给 `@nova/agent` 实现并装配。阻塞型 hook（◆）可改写 / 否决某一步，通知型 hook（○）只观察。

<div align="center">
  <img src="docs/agent-loop.svg" alt="Nova agent loop 与 hook 机制" width="100%">
</div>

### 📁 仓库结构

```
packages/
  core           agent kernel：port/hook 契约 · agent loop · turn 生命周期 · message 类型
  base           地基（叶子）：config 设置 schema + 模型表 + 计费 · host logger/session/transcript/路径安全 · prompt slash 契约 + 展开 · text 字符串工具
  model          Anthropic / OpenAI 兼容传输 · provider profile · 重试
  agent          port 实现 + 装配（assembleSession / assembleAgent）· 静态/自动记忆 + auto compact · 子 agent
  tools          ToolRegistry · dispatcher · 内置工具
  safety         PermissionEngine · 文件访问不变量 · OS 级写入沙箱
  mcp            MCP 客户端（stdio / HTTP / SSE）
  lsp            LSP 客户端/管理器（JSON-RPC over stdio）
apps/
  cli            `nova` 二进制入口（Ink/React REPL，唯一在跑的应用）
  http, vscode   占位，未实现
eval/            replay harness + 黄金 case（不走主构建）
docs/            设计笔记 & 使用手册
```

依赖方向单向不可逆：`base` / `core` / `lsp` 是叶子层（不 import `@nova/*` 源码）；`safety` / `mcp` / `agent` / `model` → `core` + `base`；`tools` → `core` + `base` + `lsp`；`cli` 在最上层，依赖以上全部。

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

<sub>为国产大模型打造 ❤️</sub>

<br><br>

<sub>如果 Nova 帮到了你，欢迎点一个 ⭐ Star</sub>

</div>
