# Nova

![Nova 截图](snapshots/screen.png)

> 一个跑在终端里的 coding agent，深度适配 DeepSeek。

Nova 是一个终端里的编码 agent —— 读代码、跑命令、改文件，通过工具调用把一项任务推到完成。内部消息走 Anthropic 的格式，但模型层是围绕 **DeepSeek** 做的：thinking 接到 DeepSeek 的 `output_config.effort`（而非 Anthropic 的 `budget_tokens`），wire format 按模型 id 自动判别，请求结构和上下文管理的默认值都对**缓存友好**，让 DeepSeek 的自动上下文缓存持续命中，默认 prompt 与权限规则也按 DeepSeek 的表现调过。其他 Anthropic 兼容端点也能跑，DeepSeek 是第一优先级。

底层是一个 loop-centric 的 harness：`@nova/core` 提供模型无关的 agent loop 和**唯一的扩展点 `HookRegistry`**，工具、权限、上下文、可观测性、skills、slash 命令全从这里接入；`@nova/agent` 把 loop 封成按 turn 跑的 `createAgent`，自带持久化与 transcript 写入；`apps/cli` 是真正在跑的入口 —— `nova` 二进制，一个全屏 Ink/React REPL，带鼠标滚动/选区与实时状态行。

---

## 核心功能

**它能干什么**——一个完整的 agentic 编码工作台：

- **Agentic 编码循环** —— 读代码、改文件、跑命令，通过工具调用把任务推到完成；同一轮里相互独立的工具调用以**有界并发**运行（默认 3 个）。
- **代码与系统工具** —— 文件 `read`（带行号 + 分页）/ `write` / `edit`、`glob` + `grep` 搜索、`bash`（60s 硬上限）与长时命令 `runLongRunningCommand`、`webfetch` / `websearch`、`notebook` 编辑、`askUserQuestion` 询问、todo / task 清单。
- **子 agent** —— 模型用 `createSubAgent` 把活儿派给**全新上下文**的 worker；内置 `explore` / `plan` / `general-purpose`，并支持用 `.md` 文件自定义任意类型。
- **LSP 代码智能** —— `lsp` 工具直连语言服务器（JSON-RPC/stdio），提供定义跳转、引用查找、hover、diagnostics 和符号搜索，比 grep 更懂作用域与类型。
- **Memory** —— CLAUDE.md 式的项目与用户 memory，每个目录按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md`（最高者胜，不合并）；`/init` 一键生成或刷新。
- **Skills** —— 启动时扫描 `SKILL.md`，把索引注入 prompt，按需 `loadSkill` 拉全文。
- **Slash 命令** —— 内置命令 + 从项目/用户目录自动加载的自定义 `.md` 命令。
- **MCP** —— 连接外部 [MCP](https://modelcontextprotocol.io) 服务器（stdio / http / sse），把工具桥接给模型，并受权限管控。
- **会话与检查点** —— 可恢复会话（`--resume` / `--continue`）配合 append-only 持久化；`/rewind` 回到更早的节点。
- **交互式 TUI** —— 全屏 REPL，带实时流式输出、鼠标滚动与选区、实时状态行，以及下一步输入预测。

## 产品亮点

**用户能直接感知的差异化**：

- **开箱即用的 DeepSeek 调优** —— 不用调 `cache_control`、不用猜 wire format、不用翻错误码文档：装好填 key 就跑，thinking 等级、缓存命中、错误提示都是 DeepSeek 语境下调过的默认值。
- **`.md` 自定义子 agent** —— 把一个 Markdown 文件丢进 `.nova/agents/`（兼容 `.claude/agents/`），frontmatter 声明 `name` / `description` / `tools`（工具白名单）/ `readOnly` / `model` / `maxTurns` / `maxTokens`，正文即角色指令 —— 立刻成为一个新的子 agent 类型，`/agents` 可见、`/agent <name> <task>` 可调、模型也能自己 `createSubAgent` 派发。
- **Plan 模式** —— `/plan <goal>` 委派一次**只读**调查，在动手改动前返回分步计划与关键权衡。
- **干净的命令 UI** —— `/agent`、`/plan`、`/init` 这类会展开成长 prompt 的命令，在历史里仍显示你**原始键入的短输入**（display override），不被冗长的展开文本刷屏。
- **沙箱默认开** —— 子进程的文件写入被 OS 级沙箱限制在工作区内，不支持的平台自动降级，无需配置即享纵深防御。
- **可恢复 + 可回退** —— `--continue` 接着上次干，`/rewind` 丢弃某条消息之后的历史与文件改动回到更早节点，`/compact` 把历史压成一条摘要。
- **可读的报错** —— 工具输入校验错误被翻译成人话（如 `command is required (expected string)`），而不是甩一坨 zod issue JSON。

## 技术亮点

**工程上的关键设计**：

- **单一扩展点的 loop** —— `@nova/core` 的 agent loop 只有一个 `HookRegistry` 扩展点：权限、压缩、transcript 写入、UI 更新、流式输出全是 hook。**阻塞型** hook（`pre_*` / `post_tool_use`）可返回 loop 必须遵守的决策（首个非 undefined 胜）；**advisory** hook（`post_*`）尽力而为、错误被吞、不能改状态。每个 `tool_use` 永远配对一个 `tool_result`，throw 或拒绝也不例外。
- **缓存友好到设计层** —— 历史 **append-only**、前缀逐字节稳定，让 DeepSeek 的服务端上下文缓存持续命中；磁盘上的 `messages.jsonl` 同样只追加写，只有真正分叉才从分叉点重写。micro 压缩**默认关闭**（它改写更早的 tool_result 会让缓存失效，在 DeepSeek 上净收益为负），auto 压缩仅在窗口吃紧时作为一次有意的前缀重置触发。
- **DeepSeek wire-format 适配** —— `detectThinkingFormat(model)` 按模型 id 自动选 `deepseek` / `anthropic` 两套 wire format；thinking 预算映射到 effort（`< 32k` → high，`>= 32k` → max）；**thinking backfill** 补上 DeepSeek 流式返回但 `finalMessage()` 丢空的 reasoning 块；7 个错误码（400/401/402/422/429/500/503）翻译成带补救建议的 `DeepSeekApiError` 并对瞬时错误内部重试。
- **进程内子 agent，全新上下文** —— 子 agent 在进程内运行、永远看不到父对话，工具集是父集减去 `createSubAgent` 本身（不会递归），只把一条最终消息汇报回来，从而把庞大的调查过程挡在主上下文之外；同一轮多个调用并发执行。
- **OS 级沙箱纵深防御** —— 基于 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)（macOS Seatbelt / Linux bubblewrap），把 `bash` 和长任务的**文件写入**限制在工作区根目录，叠在权限引擎之上，不替代它。
- **zod 边界 + 严格的依赖方向** —— 工具输入、settings、一切跨包边界都有 zod schema；`@nova/core` 模型无关、永不 import 模型 SDK / 工具实现 / UI；monorepo 依赖方向单向不可逆（见[仓库结构](#仓库结构)）。

---

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

`-t` 的等级映射到固定的 token 预算：`off` = 0、`low` = 2k、`medium` = 8k、`high` = 16k、`max` = 32k；也可以直接传一个整数预算覆盖等级。

### REPL 内置 slash 命令

```
/help                帮助
/effort [<level>]    查看 / 切换 thinking 等级
/clear               清空会话历史（保留 session）
/compact [focus…]    把历史压缩成单条摘要消息
/resume [<id>]       切到指定 session（不带参数则从列表选）
/rewind [<n>]        回退到此前某条消息（其后的历史与文件改动被丢弃）
/init [focus…]       探索代码库后生成 / 刷新项目 memory（NOVA.md/CLAUDE.md/AGENTS.md）
/plan <goal>         把调查交给只读 plan 子 agent，再给出实现计划
/commit [guidance…]  审查待提交改动、跟随仓库提交风格，创建本地提交（不 push）
/review [focus…]     审查当前未提交的 diff（只读）
/agents [reload]     列出可用的子 agent 类型；`reload` 重新扫盘
/agent <name> <task> 把任务委派给指定子 agent
/predict [on|off]    查看 / 切换下一条输入预测占位
/commands [reload]   列出已注册的 slash 命令；`reload` 重新扫盘
/skills              列出已发现的 SKILL.md
/mcp [tools]         查看 MCP 服务器状态；`tools` 列出所有桥接的工具
/lsp                 查看已配置的语言服务器（是否在 PATH、是否已启动）
/exit, /quit         退出
```

builtin 命令永远优先；在此之上，`.nova/commands` / `~/.nova/commands`（也兼容
`.claude/commands` / `~/.claude/commands`）下任意 `*.md` 都会被自动注册为 slash
命令 —— 前置 frontmatter 声明 description / arg hint / 参数，正文做占位符替换
后作为下一轮 prompt 发出去。

会展开成长 prompt 的命令（`/agent`、`/plan`、`/init` 等）在消息历史里仍显示你**原始键入的短输入**而非展开后的全文。这是每个 session 的**展示侧车**（`display-sidecar.jsonl`）记录的两类纯展示信息之一：它从不改变模型看到的内容，只改变 UI 渲染，并能跨 `/resume` 保留；`/clear` 时清空。

按 `Ctrl+D` 也能退出，按 `Esc` 中断当前回合。

### Skills

把 `SKILL.md` 放在 `.nova/skills/<name>/`（项目层）或 `~/.nova/skills/<name>/`
（用户层）下（也兼容 `.claude/skills` / `~/.claude/skills`）。Nova 启动时扫描，
将 name/description 索引注入 system prompt，并暴露 `loadSkill` 工具供模型按需
拉取完整正文。`/skills` 可以查看找到了哪些、各自来自哪里。

### 子 agent

模型可以用 `createSubAgent` 工具把活儿派出去。子 agent 在进程内运行，带**全新上下文**
（永远看不到父对话），工具集是父 agent 的工具减去 `createSubAgent` 本身 —— 所以不会
递归。三种内置类型：

- `explore` —— 只读检索（没有 write/edit/bash），定位代码并汇报路径/调用点。
- `plan` —— 只读规划，调查任务后给出分步实现计划。
- `general-purpose` —— 完整工具权限，用于需要改文件或跑命令的活儿。

同一轮里的多个 `createSubAgent` 调用会并发执行（受 `toolConcurrency` 限制）。父 agent
只会收到每个子 agent 的最终消息。通过 `settings.subagent` 配置（`enabled`、`model`、
`maxTurns`、`maxTokens`）；`/plan` slash 命令就是一层薄封装，让 agent 去派生一个 `plan`
子 agent。每个子 agent 的 transcript 落在 `~/.nova/sessions/{id}/subagents/`；其流式进度（thinking / 工具调用 / 最终汇报）会写入展示侧车，从而在 `/resume` 后仍能渲染到对应的工具调用卡片下。

#### 自定义子 agent 类型

除了三种内置类型，你可以**自己定义任意多个**。在 `.nova/agents/<name>.md`（项目层）或
`~/.nova/agents/<name>.md`（用户层）放一个 Markdown 文件即可（也兼容 `.claude/agents/`）：

```markdown
---
name: reviewer
description: read-only code reviewer that reports findings with file:line
tools: [read, grep, glob, lsp]   # 可选：工具白名单（与可用工具集求交）
readOnly: true                   # 可选：收走 write/edit/bash
model: deepseek-chat             # 可选：覆盖模型
maxTurns: 20                     # 可选：覆盖循环上限
maxTokens: 60000                 # 可选：覆盖 token 上限
---

你是一个只读代码评审子 agent。逐文件检查改动，用 file:line 报告问题……
```

- frontmatter 必填 `name`（`^[a-z][a-z0-9-]*$`）与 `description`（≤200 字符），其余可选；
  正文成为该 agent 的角色指令（注入其 system prompt）。
- **优先级**：项目层先于用户层扫描，**先出现者胜**（项目遮蔽用户）；**内置类型永远胜出**，
  同名自定义会被跳过并在 `/agents reload` 时报告。
- `createSubAgent` 的 `type` 参数对照动态注册表校验；类型不存在时返回错误并列出可用类型。
- `/agents` 列出全部（带 `[builtin]`/`[project]`/`[user]` 来源标记与约束），`/agents reload`
  原地重扫（无需重启，下次 spawn 即生效），`/agent <name> <task>` 直接委派。

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

### LSP 代码智能

`lsp` 工具让模型直连**语言服务器**（走 JSON-RPC over stdio），拿到比 grep 精确得多的导航能力 —— 它懂作用域和类型。一个工具，六个 action：

- `definition` —— 跳转到定义
- `references` —— 找所有引用
- `hover` —— 某个位置的类型/文档
- `diagnostics` —— 某个文件的错误/警告
- `document_symbols` —— 单个文件的符号大纲
- `workspace_symbol` —— 按名字跨项目搜符号

位置坐标对模型是 **1-based**（行、列），内部自动转成 LSP 的 0-based。工具是**只读**的，权限引擎默认放行。

**Nova 不安装语言服务器** —— 它们必须已经在 PATH 上。内置自动识别四种（缺失则该语言的工具调用静默降级为「未安装」提示）：

| languageId | 命令 | 扩展名 |
|------------|------|--------|
| `typescript` | `typescript-language-server --stdio` | ts/tsx/mts/cts/js/jsx/mjs/cjs |
| `python` | `pyright-langserver --stdio` | py/pyi |
| `go` | `gopls` | go |
| `rust` | `rust-analyzer` | rs |

语言服务器在**首次 `lsp` 调用时按需懒启动**，所以「已安装但未启动」是用之前的正常状态。用 **`/lsp`** 查看每种语言：二进制是否在 PATH（● running / ○ installed / ● not installed）以及本 session 是否已起。

在 `~/.nova/nova.config.json` 的 `lsp` 下配置：

```jsonc
{
  "lsp": {
    "enabled": true,            // 总开关（默认 true）
    "initTimeoutMs": 15000,     // 每个 server 的握手（initialize）超时
    "requestTimeoutMs": 15000,  // 单次请求（definition/references…）超时
    "diagnosticsTimeoutMs": 3000, // 打开文件后等 publishDiagnostics 的时长
    "servers": [                // 覆盖/扩展内置表，按 languageId 匹配
      {
        "languageId": "typescript",
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": ["ts", "tsx"]
      }
    ]
  }
}
```

`servers` 里 languageId 与内置同名的条目会**整条替换**默认值，未知的则**追加**。

### 文件读取与命令超时

- **`read` 带行号 + 分页** —— 输出是 `cat -n` 风格的行号（右对齐 6 位、tab 分隔）。参数 `offset`（1-based 起始行，默认 1）/ `limit`（最多返回行数）做基于行的分页；单次响应上限约 200K 字符，超长单行整行返回不会从中间切断，截断时会附上精确的续读调用（如 `read(path="…", offset=<下一行>)`）。
- **`bash` 60s 硬上限** —— `timeout_ms` 可选、上限 60000ms。开发服务器、watcher、长构建、下载这类可能超时的活儿改用 `runLongRunningCommand` / `checkLongRunningCommand`。

### 命令沙箱（可选，OS 级隔离）

把会起子进程的工具（`bash`、`runLongRunningCommand`）放进操作系统级沙箱里跑，
把**文件写入**限制在工作区根目录内（与权限引擎用的允许根一致）。底层是
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)：
macOS 用 Seatbelt（`sandbox-exec`），Linux 用 bubblewrap。这是叠在权限引擎之上的
**纵深防御**，不是替代品。

默认**开启**（opt-out）。读放行、**网络不限制**（只管文件系统）。不支持的平台或缺依赖会
自动降级为不沙箱，所以默认开是安全的。要彻底关掉设 `"enabled": false`。
在 `~/.nova/nova.config.json`：

```jsonc
{
  "sandbox": {
    "enabled": true,            // 总开关（默认 true；设 false 彻底关闭）
    "monitorViolations": true,  // 捕获越权写并标注到命令输出（macOS 起一个 log 监听）
    "filesystem": {
      // 工作区根（cwd + permissions.additionalDirectories）始终可写。
      // allowWrite 默认已预置一组常见缓存（~/.npm ~/.cache ~/Library/Caches
      // ~/.cargo ~/.rustup ~/go ~/.local/share/pnpm ~/Library/pnpm ~/.yarn），
      // 让 npm/pnpm/cargo/go 开箱即用；显式设置会**替换**这组默认值。
      "allowWrite": ["~/.npm", "~/.cargo", "/some/extra/dir"],
      "denyWrite": [".env"],      // 即使在允许根内也拒绝写
      "denyRead": ["~/.ssh"],     // 读默认放行，这里单独拒绝
      "allowGitConfig": true      // 放行 .git/config 写（默认 true）
    }
  }
}
```

- 仅 **macOS / Linux**；不支持的平台或缺依赖（macOS 需 `ripgrep`；Linux 还需
  `bubblewrap`/`socat`）会**静默降级**为不沙箱，agent 照常运行。
- 常见包管理器缓存默认已放行（见上）；如果某个命令要写到别处（工作区外）被拦，
  把对应路径加进 `filesystem.allowWrite` 即可。
- **工作区内有一组危险路径被 SDK 强制保护、即使在工作区里也写不了**：`.git/hooks`、
  `.git/config`、`.vscode/`、`.idea/`、`.claude/{commands,agents}`，以及
  `.gitconfig`/`.zshrc`/`.mcp.json` 等 dotfile。这些是 SDK 写死的安全策略，只有
  `.git/config` 能通过 `allowGitConfig`（默认 true）放行，`.git/hooks` 始终拦。
  要写其它被保护路径，只能整个关掉沙箱（`enabled: false`）。

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
                   webfetch · websearch · askUserQuestion · lsp
                   todo (todoCreate/Update/Get/Clear) · task (taskCreate/Update/Get/List/Clear)
                   runLongRunningCommand / checkLongRunningCommand · loadSkill
  subagent       createSubAgent 工具 · 子 agent 定义/注册表/加载器（内置 + .md 自定义）
  context        三层记忆（NOVA.md > CLAUDE.md > AGENTS.md）· auto compact（micro 默认关闭）
  safety         PermissionEngine · approval 提示（规则匹配 + read 限定在 cwd）
  sandbox        OS 级命令沙箱（@anthropic-ai/sandbox-runtime）：bash/长任务的文件写入隔离
  lsp            LSP 客户端/管理器（JSON-RPC over stdio）· 语言服务器解析（lazy 启动）
  external       SlashRegistry · .md slash 命令加载 · MCP 客户端（stdio/http 传输、工具桥接）
  observability  Transcript (JSONL)
apps/
  cli            nova 二进制入口（Ink/React REPL，唯一在跑的 app）
  http, vscode   占位，未实现
eval/            replay harness + 黄金 case（不走主构建，eslint/tsconfig 已排除）
docs/            设计笔记（skills、ask-user）
```

依赖方向单向不可逆（按实际源码 import）：`runtime` / `core` / `observability` / `lsp` 是叶子层（不 import 任何 `@nova/*` 源码）；`safety` → `runtime`；`context` → `core` + `runtime`；`tools` → `core` + `runtime` + `lsp`；`sandbox` / `external` → `core`（仅 type-only）；`agent` → `core` + `runtime` + `context` + `observability`；`subagent` → `agent` + `context` + `core` + `observability` + `runtime`；`cli` 在最上层，依赖以上全部。

`@nova/*` package 在 workspace 内通过 `./src/index.ts` 直接互相 import；发布时通过 `publishConfig` 切到 `dist/`。

## 数据落在哪

| 内容 | 路径 |
|------|------|
| 全局配置 | `~/.nova/nova.config.json` |
| 历史 session | `~/.nova/sessions/{id}/` |
| transcript (observer 事件流) | `~/.nova/sessions/{id}/transcript.jsonl` |
| 可重放 message 历史 | `~/.nova/sessions/{id}/messages.jsonl` |
| 展示侧车（slash 输入覆盖 + 子 agent 进度，仅渲染用） | `~/.nova/sessions/{id}/display-sidecar.jsonl` |
| 子 agent transcript/message | `~/.nova/sessions/{id}/subagents/` |
| session 日志 | `~/.nova/sessions/{id}/session.log` |
| 记忆文件（项目层） | 从 cwd 向上递归，每层按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 取最优先的一个（同目录不合并） |
| 记忆文件（用户层） | `~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md`（按顺序取第一个存在的） |
| 自定义子 agent 定义 | `.nova/agents/*.md`（项目层）· `~/.nova/agents/*.md`（用户层）；兼容 `.claude/agents/` |

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
