# Nova

![Nova 截图](snapshots/screen.png)

> 一个跑在终端里的 coding agent，深度适配 DeepSeek。

Nova 是一个终端里的编码 agent —— 读代码、跑命令、改文件，通过工具调用把一项任务推到完成。内部消息走的是 Anthropic 的格式，但模型层是围绕 **DeepSeek** 做的：thinking 接到 DeepSeek 的 `output_config.effort`（而不是 Anthropic 的 `budget_tokens`），wire format 会根据模型 id 自动判断，请求结构和上下文管理的默认值都做得**对缓存友好**，让 DeepSeek 的自动上下文缓存持续命中，默认 prompt 和权限规则也按 DeepSeek 的表现调过。其他 Anthropic 兼容端点也能跑，只是 DeepSeek 是第一优先级。

底层上 Nova 是一个 loop-centric 的 harness：`@nova/core` 提供模型无关的 agent loop 和统一的 `HookRegistry` 扩展点，工具、权限、上下文、可观测性、skills、slash 命令都从这里接入；`@nova/agent` 把 loop 封成按 turn 跑的 `createAgent`，自带持久化和 transcript 写入；`apps/cli` 是真正在跑的入口 —— `nova` 二进制，一个全屏 Ink/React REPL，支持鼠标滚动/选区和实时状态行。

loop 以**有界并发**跑工具调用（每轮默认 3 个），模型还能通过 `createSubAgent` 工具派生**子 agent** —— 全新上下文的 worker（`explore` / `plan` / `general-purpose`），在进程内运行、只把一条最终消息汇报回来，从而把庞大的调查过程挡在主上下文之外。

## 快速开始

环境要求：**Node ≥ 20**（见 `.nvmrc`），**pnpm 10.28.2**。

```bash
pnpm install
pnpm dev                                # 启动 REPL（tsx 运行 apps/cli/src/index.ts）
pnpm dev "帮我把这个函数加单测"          # 先跑一轮 prompt，再进入 REPL
```

首次启动会进入交互式配置向导写入 `~/.nova/nova.config.json`（API key、模型、session 目录等）。也可以手动编辑。

### CLI 常用参数

```bash
pnpm dev [prompt...]                # 先跑一轮初始 prompt，再留在 REPL
  -p, --prompt <text>               # 初始 prompt（位置参数的替代写法）
  -m, --model <name>                # 临时覆盖模型
  -t, --think off|low|medium|high|max   # extended thinking 等级（或整数预算）
  --cwd <dir>                       # 工具的工作目录
  --resume <id>                     # 恢复指定 session
  -c, --continue                    # 恢复最近一个 session
  --list-sessions                   # 列出历史 session 后退出
  --max-turns <n>                   # 单轮最大循环次数
  --no-transcript                   # 不写 transcript
  --no-pretty                       # 关闭 pretty 日志
```

### REPL 内置 slash 命令

```
/help                帮助
/model [<name>]      查看 / 切换模型
/think [<level>]     查看 / 切换 thinking 等级
/clear               清空会话历史（保留 session）
/compact [focus…]    把历史压缩成单条摘要消息
/plan <goal>         把调查交给只读 plan 子 agent，再给出实现计划
/resume [<id>]       切到指定 session（不带参数则从列表选）
/predict [on|off]    查看 / 切换下一条输入预测占位
/commands [reload]   列出已注册的 slash 命令；`reload` 重新扫盘
/skills              列出已发现的 SKILL.md
/mcp [tools]         查看 MCP 服务器状态；`tools` 列出所有桥接的工具
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

### 子 agent

模型可以用 `createSubAgent` 工具把活儿派出去。子 agent 在进程内运行，带**全新上下文**
（永远看不到父对话），工具集是父 agent 的工具减去 `createSubAgent` 本身 —— 所以不会
递归。三种类型：

- `explore` —— 只读检索（没有 write/edit/bash），定位代码并汇报路径/调用点。
- `plan` —— 只读规划，调查任务后给出分步实现计划。
- `general-purpose` —— 完整工具权限，用于需要改文件或跑命令的活儿。

同一轮里的多个 `createSubAgent` 调用会并发执行（受 `toolConcurrency` 限制）。父 agent
只会收到每个子 agent 的最终消息。通过 `settings.subagent` 配置（`enabled`、`model`、
`maxTurns`、`maxTokens`）；`/plan` slash 命令就是一层薄封装，让 agent 去派生一个 `plan`
子 agent。每个子 agent 的 transcript 落在 `~/.nova/sessions/{id}/subagents/`。

### MCP（Model Context Protocol）

Nova 可以在启动时连接外部 [MCP](https://modelcontextprotocol.io) 服务器，把它们的
工具以 `mcp__<服务器>__<工具>` 的形式暴露给模型，并走正常的权限引擎（默认 **ask**）。
服务器原生的 JSON Schema 会原样发给模型，工具契约保持不变。支持两种传输：本地子进程
走 **stdio**，或远程 **http**/**sse** 端点。

在 `~/.nova/nova.config.json` 的 `mcp.servers` 下配置：

```jsonc
{
  "mcp": {
    "enabled": true,          // 总开关（默认 true）
    "timeoutMs": 60000,       // 单次工具调用超时
    "servers": {
      "filesystem": {         // stdio（type 默认 "stdio"）
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        "env": { "FOO": "bar" }   // 可选；会合并到一份安全的默认环境之上
      },
      "remote": {             // http / sse
        "type": "http",
        "url": "https://example.com/mcp",
        "headers": { "authorization": "Bearer …" }
      },
      "scratch": { "command": "…", "enabled": false }   // 单独跳过某个服务器
    }
  }
}
```

各服务器并行连接；某个连不上只会记日志并跳过 —— 既不会阻塞启动，也不影响其他服务器。
用 **`/mcp`** 查看每个服务器的状态和工具数，**`/mcp tools`** 列出所有桥接的工具名。

### 上下文缓存（DeepSeek）

DeepSeek 的 Anthropic 兼容端点会做自动的、服务端的**上下文缓存**：只要某个请求的
前缀和之前的某个请求完全一致，重复的那部分 token 就直接从缓存里读出来（按远低于
正常输入的价格计费），而不是重新算一遍。这里没有 `cache_control` 之类的开关要设 ——
唯一要紧的是消息前缀在一轮一轮之间保持逐字节稳定。Nova 整个就是围绕「保持前缀稳定」
来设计的：

- **历史只追加。** 每轮只往后追加新消息，从不改写更早的内容，所以缓存前缀能存活。
  持久化也是同样逻辑 —— 只要磁盘上的前缀没变，`messages.jsonl` 就只做追加写，
  只有真正出现分叉时才从分叉点开始重写。
- **micro 压缩默认关闭。** 它每轮都会改写更早的 `tool_result`，会把从改写点到结尾的
  缓存全部失效 —— 而它裁掉的那些 token 本来就按便宜的缓存读取价计费，所以在 DeepSeek 上
  净收益是「微弱到负」。auto 压缩仍然开着：它只在上下文窗口吃紧时触发，作为一次有意为之的
  前缀重置。只有在没有前缀缓存的 provider 上才建议把 `compact.micro.enabled` 设为 `true`。
- **缓存计量。** 每个响应的 `cache_read_input_tokens` / `cache_creation_input_tokens`
  都会被读出来并累加进本 session 的用量统计，所以你能看到每一轮里到底有多少命中了缓存。

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
  subagent       createSubAgent 工具 · 子 agent system prompt（explore/plan/general-purpose）
  context        三层记忆（NOVA.md > CLAUDE.md > AGENTS.md）· auto compact（micro 默认关闭）
  safety         PermissionEngine · approval 提示（规则匹配 + read 限定在 cwd）
  external       SlashRegistry · .md slash 命令加载 · MCP 客户端（stdio/http 传输、工具桥接）
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
| 子 agent transcript/message | `~/.nova/sessions/{id}/subagents/` |
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
