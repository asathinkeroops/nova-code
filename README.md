<p align="center">
  <img src="docs/logo.svg" alt="NOVA-CODE" width="600">
</p>

**简体中文** · [English](README.en-US.md)

![Nova 截图](snapshots/screen.png)

> 为 DeepSeek 量身打造的编程代理 — 95%+ 缓存命中 · OS 级沙箱 · 工具齐全 · 开箱即用。

Nova 读代码、跑命令、改文件——通过工具调用把任务推到完成。模型层围绕 **DeepSeek** 构建：thinking 映射到 effort（而非 `budget_tokens`）、wire format 按模型 id 自动判别、整个请求管线为 DeepSeek 的自动上下文缓存做了调优，让缓存持续命中。其他 Anthropic 兼容端点也能跑，DeepSeek 是第一优先级。

## 为什么选 Nova

**DeepSeek 原生适配，零配置。**
不用调 `cache_control`、不用猜 wire format、不用翻错误码文档。装好，填 key，开干。thinking 等级、缓存命中、错误提示——全部围绕 DeepSeek 调过，开箱即用。

**缓存友好刻在骨子里。**
历史 append-only，前缀逐字节稳定，让 DeepSeek 的服务端缓存每轮都命中——响应更快、token 更省。micro 压缩默认关闭（它会破坏缓存前缀），auto 压缩只在窗口真正吃紧时才触发。

**沙箱默认开启，纵深防御。**
子进程文件写入被 OS 级沙箱限制在工作区（macOS Seatbelt / Linux bubblewrap），叠在权限引擎之上。不支持的平台静默降级——无需配置即有防护。

**用 Markdown 扩展一切。**
自定义子 agent、slash 命令、skills、生命周期 hooks——一个 `.md` 文件、frontmatter 写配置、正文写指令，即刻生效。不需改代码，可随仓库分发。

**使用习惯无缝迁移。**
高度复刻 Claude Code 的交互方式——同样的 slash 命令、快捷键、审批弹窗、记忆文件、可重放会话。用过 Claude Code 就零学习成本：装好继续按原有习惯干活，只是底层换成了为 DeepSeek 量身调优的引擎。

## 快速开始

环境要求：**Node ≥ 20**，**pnpm 10.28.2**。

```bash
pnpm install
pnpm dev                           # 启动 REPL
pnpm dev -p "解释这段代码"           # headless 模式：只跑一轮，输出后退出
```

首次启动进入交互式配置向导，写入 `~/.nova/nova.config.json`（API key、模型、session 目录等）。

## 功能概览

### 内置工具

模型能调用的工具，覆盖读写、搜索、执行、代码智能、联网：

| 工具 | 能力 |
| --- | --- |
| `read` / `write` / `edit` | 读文件（行号 + 分页，含 `.xlsx` / `.ods` 表格和图片）、整文件写、精确文本替换 |
| `glob` / `grep` | 按文件名匹配、全文正则搜索 |
| `bash` | 运行 shell 命令 |
| `runInBackground` / `getBackgroundOutput` / `killBackground` | 后台跑 dev server、watcher 等长任务 |
| `lsp` | 代码智能：定义跳转、引用查找、hover、diagnostics、符号搜索 |
| `webfetch` / `websearch` | 抓取网页、联网搜索 |
| `createTodo` / `updateTodo` / `getTodoList` / `clearTodoList` | 会话内多步清单 |
| `createTask` / `updateTask` / `getTaskList` / `clearTaskList` | 跨会话任务计划，支持依赖 |
| `askUserQuestion` | 向用户提多选问题并等待作答 |
| `loadSkill` | 按需加载 skill |

### 内置命令

| 命令 | 能力 |
| --- | --- |
| `/help` | 查看所有命令 |
| `/model` · `/effort` | 切换模型、调整思考等级 |
| `/compact` | 压缩长历史成摘要 |
| `/clear` · `/resume` · `/rewind` | 开新会话、恢复历史会话、回退历史 |
| `/rename` | 给当前会话起个名字（显示在输入框边框上） |
| `/plan` | 只读调研出实现方案，不动手 |
| `/goal` | 设定成功条件后自动推进直到达成 |
| `/diff` · `/review` | 浏览、评审未提交改动 |
| `/init` | 分析代码库生成 `NOVA.md` |
| `/agents` · `/agent` | 查看子 agent 类型、委派任务 |
| `/commands` · `/skills` · `/mcp` · `/lsp` | 查看已注册命令、skills、MCP 服务器、语言服务器 |
| `/usage` · `/context` | 查看 token 用量、缓存命中、上下文占用 |
| `/tasks` | 查看和管理后台命令（`runInBackground`），支持 list / stop |
| `/predict` | 开关下一条输入预测 |
| `/exit` · `/quit` | 退出 |

### 核心特性

| 特性 | 能力 |
| --- | --- |
| 子 agent | 带全新上下文、独立工具集干活：`explore` 只读检索、`plan` 只读规划、`general-purpose` 全权限，可自定义 |
| 权限与沙箱 | `shift+tab` 切换 `default` / `acceptEdits` / `plan`；OS 级沙箱把子进程写入隔离在工作区（macOS Seatbelt / Linux bubblewrap），默认开启 |
| 文件防护 | 改文件前强制先读、检测外部改动，避免误覆盖 |
| MCP | 接入外部 MCP 服务器（`stdio` / `http` / `sse`），把它们的工具当内置工具用，同样受权限管控 |
| Skills | 把可复用操作手册写成 `SKILL.md`，模型按需加载，省 token 又能随仓库分发 |
| Markdown 扩展 | 自定义 slash 命令、子 agent、生命周期 hooks，丢 `.md` 进 `.nova/`、frontmatter 配置，免改代码 |
| 三层记忆 | 全局 → 用户 → 项目，按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 优先级加载 |
| 交互体验 | 全屏 Ink/React REPL，流式输出 + 鼠标；`@path` / `/` 补全、`↑` `↓` 翻历史；实时状态行显示 token 用量、缓存命中、花费、DeepSeek 余额、git 分支、上下文占用 |

## 架构

Nova 的核心是一个模型循环（`agentLoop`），只有**一个扩展点**——类型化的 `HookRegistry`。权限闸门、上下文压缩、transcript 写入、UI 刷新都以 hook 的形式挂在具名生命周期点上；`@nova/core` 本身不导入任何模型 SDK、工具实现或 UI。阻塞型 hook（◆）可改写 / 否决某一步，通知型 hook（○）只观察。

![Nova agent loop 与 hook 机制](docs/agent-loop.svg)

## 仓库结构

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

## 开发

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

## License

[MIT](LICENSE) © Nova contributors.
