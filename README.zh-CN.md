# Nova

![Nova 截图](snapshots/screen.png)

> 一个跑在终端里的 coding agent，深度适配 DeepSeek。

Nova 是一个终端里的编码 agent —— 读代码、跑命令、改文件，通过工具调用把一项任务推到完成。内部消息走的是 Anthropic 的格式，但模型层是围绕 **DeepSeek** 做的：thinking 接到 DeepSeek 的 `output_config.effort`（而不是 Anthropic 的 `budget_tokens`），wire format 会根据模型 id 自动判断，默认 prompt 和权限规则也按 DeepSeek 的表现调过。其他 Anthropic 兼容端点也能跑，只是 DeepSeek 是第一优先级。

底层上 Nova 是一个 loop-centric 的 harness：`@nova/core` 提供模型无关的 agent loop 和统一的 `HookRegistry` 扩展点，工具、权限、上下文、可观测性、skills、slash 命令都从这里接入；`@nova/agent` 把 loop 封成按 turn 跑的 `createAgent`，自带持久化和 transcript 写入；`apps/cli` 是真正在跑的入口 —— `nova` 二进制，一个 Ink/React 的 REPL。

## 快速开始

环境要求：**Node ≥ 20**（见 `.nvmrc`），**pnpm 10.28.2**。

```bash
pnpm install
pnpm dev                                # 启动 REPL（tsx 运行 apps/cli/src/index.ts）
pnpm dev "帮我把这个函数加单测"          # 直接给出 prompt
```

首次启动会进入交互式配置向导写入 `~/.nova/nova.config.json`（API key、模型、session 目录等）。也可以手动编辑。

### CLI 常用参数

```bash
pnpm dev [prompt...]                # 直接发起一轮对话
  --model <name>                    # 临时覆盖模型
  --think off|low|medium|high|max   # 调整 extended thinking 预算
  --resume <session-id>             # 恢复指定 session
  --continue                        # 恢复最近一个 session
  --list-sessions                   # 列出历史 session
  --max-turns <n>                   # 单轮最大循环次数
  --no-transcript                   # 不写 transcript
  --no-pretty                       # 关闭 pino-pretty
```

### REPL 内置 slash 命令

```
/help                帮助
/model [<name>]      查看 / 切换模型
/think [<level>]     查看 / 切换 thinking 等级
/clear               清空会话历史（保留 session）
/compact [focus…]    把历史压缩成单条摘要消息
/resume [<id>]       切到指定 session（不带参数则从列表选）
/predict [on|off]    查看 / 切换下一条输入预测占位
/commands [reload]   列出已注册的 slash 命令；`reload` 重新扫盘
/skills              列出已发现的 SKILL.md
/exit, /quit         退出
```

builtin 命令永远优先；在此之上，`.nova/commands` / `~/.nova/commands`（也兼容
`.claude/commands` / `~/.claude/commands`）下任意 `*.md` 都会被自动注册为 slash
命令 —— 前置 frontmatter 声明 description / arg hint / 参数，正文做占位符替换
后作为下一轮 prompt 发出去。

按 `Ctrl+D` 也能退出，按 `Esc` 中断当前回合。

### Skills

把 `SKILL.md` 放在 `.nova/skills/<name>/`（项目层）或 `~/.nova/skills/<name>/`
（用户层）下（也兼容 `.claude/skills` / `~/.claude/skills`）。Nova 启动时扫描，
将 name/description 索引注入 system prompt，并暴露 `loadSkill` 工具供模型按需
拉取完整正文。`/skills` 可以查看找到了哪些、各自来自哪里。

## 仓库结构

```
packages/
  core           agent loop · model client · HookRegistry · message/stop-reason 类型
  agent          createAgent：按 turn 跑的驱动 + 持久化 + transcript 接线
  runtime        settings (zod) · pino logger · session 存储
  tools          ToolRegistry · dispatcher · 内置工具
                   bash · read · write · edit · glob · grep · notebook-edit
                   webfetch · websearch · askUserQuestion
                   todo (todoCreate/Update/Get/Clear) · task (taskCreate/Update/Get/List/Clear)
                   runLongRunningCommand / checkLongRunningCommand · loadSkill
  context        三层记忆（NOVA.md > CLAUDE.md > AGENTS.md）· micro/auto compact
  safety         PermissionEngine · approval 提示（规则匹配 + read 限定在 cwd）
  external       SlashRegistry · .md slash 命令加载（MCP / transport 仍是占位）
  observability  Transcript (JSONL)
  multi-agent, isolation, sdk
                 预留位
apps/
  cli            nova 二进制入口（Ink/React REPL，唯一在跑的 app）
  http, vscode   占位，未实现
eval/            replay harness + 黄金 case（不走主构建，eslint/tsconfig 已排除）
docs/            设计笔记（skills、ask-user）
```

`@nova/*` package 在 workspace 内通过 `./src/index.ts` 直接互相 import；发布时通过 `publishConfig` 切到 `dist/`。

## 数据落在哪

| 内容 | 路径 |
|------|------|
| 全局配置 | `~/.nova/nova.config.json` |
| 历史 session | `~/.nova/sessions/{id}/` |
| transcript (observer 事件流) | `~/.nova/sessions/{id}/transcript.jsonl` |
| 可重放 message 历史 | `~/.nova/sessions/{id}/messages.jsonl` |
| session 日志 | `~/.nova/sessions/{id}/session.log` |
| 记忆文件（项目层） | 从 cwd 向上递归，每层按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 取最优先的一个（同目录不合并） |
| 记忆文件（用户层） | `~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md`（按顺序取第一个存在的） |

## 开发

```bash
pnpm build                # 全量构建（tsup，递归）
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run
pnpm test:watch
pnpm vitest run path/to/file.test.ts   # 跑单个测试文件
pnpm vitest run -t "name"              # 按名字过滤
pnpm lint / pnpm lint:fix
pnpm format / pnpm format:check
```

单包脚本可通过 `pnpm --filter @nova/<name> <script>` 调用。测试文件按 `packages/*/src/**/*.test.ts(x)` 收集，和源码并排放。

新加协作者请先读：

- `CLAUDE.md` — 给 AI assistant 看的项目导览（架构约定、loop 契约、ESM `.js` 后缀、zod 边界等）
- `agent-harness-loop-architecture.html` — 架构总图

## License

[MIT](LICENSE) © Nova contributors.
