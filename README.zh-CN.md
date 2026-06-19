# Nova

![Nova 截图](snapshots/screen.png)

> 为 DeepSeek 深度调优的终端 AI 编程代理。缓存友好，沙箱默开，开箱即用。

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

## 快速开始

环境要求：**Node ≥ 20**，**pnpm 10.28.2**。

```bash
pnpm install
pnpm dev                           # 启动 REPL
pnpm dev "帮我加单测"               # 先跑一轮 prompt，再留在 REPL
pnpm dev -p "解释这段代码"           # headless 模式：只跑一轮，输出后退出
```

首次启动进入交互式配置向导，写入 `~/.nova/nova.config.json`（API key、模型、session 目录等）。

## 功能概览

**Agent 循环**
- 多轮工具调用，同轮内独立调用以有界并发运行（默认 3 个）
- 子 agent 带全新上下文 — `explore`、`plan`、`general-purpose`，外加自定义 `.md` 类型
- Plan 模式 — `/plan` 先做只读调查，再动手
- 可恢复会话，append-only 持久化，`/rewind` 可回退
- `/model` 会话内换模型，`/compact` 压缩长历史

**代码智能**
- LSP 工具 — 定义跳转、引用查找、hover、diagnostics、符号搜索（懂作用域和类型）
- `read`（带行号 + 分页，支持 `.xlsx` / `.ods`）、`write`、`edit`
- `glob` + `grep` 搜索，`webfetch` + `websearch`

**安全**
- 权限引擎 — 一键切换模式（shift+tab：`default` → `acceptEdits` → `plan`）
- OS 级沙箱 — 写入隔离、网络放行、默认开启、不支持的平台自动降级
- 生命周期 hooks — 用 shell 脚本做自动格式化、工具拦截、上下文注入

**可扩展性**
- 自定义子 agent — 丢一个 `.md` 到 `.nova/agents/`，frontmatter 声明工具和模型
- 自定义 slash 命令 — `.md` 文件放入 `.nova/commands/`
- Skills — 启动时扫描 `SKILL.md`，按需 `loadSkill` 拉全文
- MCP — 连接外部服务器（stdio / HTTP / SSE），桥接工具给模型

**交互体验**
- 全屏 Ink/React REPL，实时流式输出，支持鼠标
- `!` shell 直通 — `!git status` 本地执行，不弹权限确认
- `@path` 模糊文件补全
- 实时状态行 — token 用量、缓存命中率、花费估算、DeepSeek 账户余额

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
- `agent-harness-loop-architecture.html` — 架构总图

## License

[MIT](LICENSE) © Nova contributors.
