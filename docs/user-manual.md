# Nova 使用手册

> Nova（命令行二进制 `nova`，本手册中也称 *nova-code*）是一个跑在终端里的编码 agent —— 它读代码、跑命令、改文件，通过工具调用把一项任务推到完成。内部消息走 Anthropic 格式，模型层围绕 **DeepSeek** 深度调优，同时兼容其它 Anthropic 兼容端点。

本手册面向 **使用者**：怎么装、怎么配、怎么在日常里把它用顺。如果你想了解内部架构（loop 契约、包依赖、扩展点），请读 `CLAUDE.md` 与仓库根的 `README.md`。

---

## 目录

1. [它能做什么](#1-它能做什么)
2. [安装与环境要求](#2-安装与环境要求)
3. [首次配置向导](#3-首次配置向导)
4. [启动与命令行参数](#4-启动与命令行参数)
5. [交互式界面（TUI）](#5-交互式界面tui)
6. [Slash 命令大全](#6-slash-命令大全)
7. [思考等级（Thinking）](#7-思考等级thinking)
8. [Plan 模式与子 Agent](#8-plan-模式与子-agent)
9. [内置工具一览](#9-内置工具一览)
10. [权限与安全](#10-权限与安全)
11. [命令沙箱](#11-命令沙箱)
12. [上下文管理与压缩](#12-上下文管理与压缩)
13. [记忆（Memory）](#13-记忆memory)
14. [Skills](#14-skills)
15. [自定义 Slash 命令](#15-自定义-slash-命令)
16. [MCP 外部工具](#16-mcp-外部工具)
17. [LSP 代码智能](#17-lsp-代码智能)
18. [会话、检查点与数据落盘](#18-会话检查点与数据落盘)
19. [配置文件完整参考](#19-配置文件完整参考)
20. [常见问题与排查](#20-常见问题与排查)

---

## 1. 它能做什么

- **Agentic 编码循环** —— 给它一个目标，它自己读代码、改文件、跑命令，一步步把任务做完。同一轮里互相独立的工具调用以**有界并发**运行（默认每轮 3 个）。
- **代码与系统工具** —— 文件 read / write / edit，`glob` + `grep` 搜索，`bash` 与后台长任务，web fetch / search，notebook 编辑，向你提问。
- **LSP 代码智能** —— 直连语言服务器做 go-to-definition、find-references、hover、诊断、符号搜索，比 grep 更懂作用域和类型。
- **扩展 thinking** —— 五档（`off`/`low`/`medium`/`high`/`max`）或显式 token 预算。
- **Plan 模式与子 agent** —— 把庞大的调查/规划交给全新上下文的 worker，结论汇报回来，主对话保持干净。
- **记忆、Skills、自定义命令、MCP** —— 项目/用户级的知识与工具扩展。
- **权限与沙箱** —— 基于规则的拦截 + OS 级文件写入隔离，双层防护。
- **可恢复会话** —— append-only 持久化，随时 `--resume` / `--continue`，`/rewind` 回到更早节点。
- **DeepSeek 深度定制** —— thinking 映射到 DeepSeek 的 `output_config.effort`，请求结构对自动上下文缓存友好，错误码翻译与瞬时重试。

---

## 2. 安装与环境要求

环境要求：

- **Node ≥ 20**（仓库 `.nvmrc` 已固定）
- **pnpm 10.28.2**（`packageManager` 已固定）
- 一个**交互式终端（TTY）**。Nova 不支持管道/重定向/无 PTY 的 CI 环境——非 TTY 启动会直接报错退出。

从源码运行：

```bash
pnpm install
pnpm dev                       # 启动 REPL（tsx 运行 apps/cli/src/index.ts）
pnpm dev "帮我给这个函数加单测"   # 先跑一轮 prompt，再进入 REPL
```

> `pnpm dev` 是开发态入口；发布后的二进制名为 `nova`，本手册中 `nova ...` 与 `pnpm dev ...` 等价。

---

## 3. 首次配置向导

第一次启动时，如果 `~/.nova/nova.config.json` 里缺少必填项，Nova 会进入一个交互式向导，依次询问三项并写回配置文件：

| 字段 | 说明 |
|------|------|
| **Base URL** | 必须是 Anthropic 兼容端点（如 `https://api.anthropic.com`，或 DeepSeek 的兼容端点） |
| **API key** | 你的 provider API key（输入时被掩码） |
| **Model** | 模型 id，例如 `claude-sonnet-4-5` |

按 `Ctrl+C` 可中止向导。已有的字段不会再问。你也可以随时手动编辑 `~/.nova/nova.config.json`（完整字段见 [§19](#19-配置文件完整参考)）。

> 如果启动时 `apiKey` 仍为空，Nova 会报错退出并提示去配置文件里补上。

---

## 4. 启动与命令行参数

```bash
nova [prompt...]                   # 先跑一轮初始 prompt，再留在 REPL
  -p, --prompt <text>              # 初始 prompt（位置参数的替代写法）
  -m, --model <name>               # 临时覆盖模型 id
  -t, --think off|low|medium|high|max   # thinking 等级，或一个正整数 token 预算
      --max-turns <n>              # 单轮最大循环次数
      --cwd <dir>                  # 工具的工作目录（工作区根）
      --resume <id>                # 恢复指定 id 的 session
  -c, --continue                   # 恢复最近一个 session
      --list-sessions              # 列出历史 session 后退出（非交互）
      --no-transcript              # 本次不写 transcript
      --no-pretty                  # 关闭 pretty 日志
```

要点：

- **位置参数即初始 prompt**：`nova 把 README 翻译成英文` 会先跑这一轮，再停在 REPL 等你继续。`-p/--prompt` 是等价写法。
- **`-m` / `-t` / `--max-turns` 都是本次会话的临时覆盖**，不写回配置文件。
- **`--cwd`** 决定工具的「工作区根」——读写权限、沙箱写入范围都以它为基准（见 [§10](#10-权限与安全)）。
- **`--list-sessions`** 是少数几个非交互子命令，打印列表后直接退出。

---

## 5. 交互式界面（TUI）

Nova 是一个全屏 Ink/React REPL：顶部是滚动的历史区，底部是固定的输入框和实时状态行，支持流式输出、鼠标滚动与选区。

### 全局按键

| 按键 | 作用 |
|------|------|
| `Enter` | 提交当前输入 |
| `Esc` | 中断正在运行的回合 |
| `Ctrl+C` | 有回合在跑时中断它；空闲时再按一次退出 |
| `Ctrl+D` | 退出 Nova |
| 鼠标滚轮 | 在历史区上下滚动 |
| 鼠标拖拽 | 选中文本（用于复制） |

### 输入框编辑键（emacs 风格）

| 按键 | 作用 |
|------|------|
| `Ctrl+A` / `Ctrl+E` | 跳到行首 / 行尾 |
| `Ctrl+U` / `Ctrl+K` | 删除到行首 / 删除到行尾 |
| `Ctrl+W` | 往前删一个词 |
| `↑` / `↓` | 浏览输入历史 / 在补全弹窗里移动 |

### 选择类弹窗（审批、提问、session 选择器）

- 上下移动：`↑`/`↓`，或 `j`/`k`（审批框），或 `Ctrl+P`/`Ctrl+N`（选择器）
- 确认：`Enter`；取消/拒绝：`Esc`
- 多选题用 `空格` 勾选
- 审批框还支持 `PageUp`/`PageDown` 滚动周围的视口，方便先看清要批准的内容

### 输入预测

每成功跑完一轮，Nova 会用主模型预测你**下一句可能想说什么**，作为输入框的灰色占位提示（默认开启，超时 8s，最多 50 字）。用 `/predict on|off` 开关，或在配置里调 `predict`。

---

## 6. Slash 命令大全

在输入框里以 `/` 开头即触发。内置命令永远优先于自定义命令。

| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助；列出按来源分组（Built-in / Project / User）的命令 |
| `/think [<level>]` | 查看或切换 thinking 等级（`off`/`low`/`medium`/`high`/`max` 或整数预算） |
| `/clear` | 清空当前会话历史（session 仍保留） |
| `/compact [focus…]` | 把历史压缩成单条摘要消息；可附带关注点提示 |
| `/resume [<id>]` | 切换到指定 session；不带参数则弹出列表选择 |
| `/rewind [<n>]` | 回退到此前某条消息——其后的对话历史与文件改动都会被丢弃 |
| `/plan <goal>` | 把调查交给一个只读的 plan 子 agent，返回分步实现计划 |
| `/predict [on\|off]` | 查看或切换「下一条输入预测」 |
| `/commands [reload]` | 列出已注册的 slash 命令；`reload` 重新扫盘加载自定义命令 |
| `/skills` | 列出已发现的 `SKILL.md`（及各自来源） |
| `/mcp [tools]` | 查看 MCP 服务器状态；`tools` 列出所有桥接的工具 |
| `/lsp` | 查看已配置的语言服务器（是否在 PATH、本 session 是否已启动） |
| `/exit`, `/quit` | 退出 |

实际注册的内置命令为：`help`、`think`、`clear`、`compact`、`resume`、`rewind`、`plan`、`predict`、`commands`、`skills`、`mcp`、`lsp`、`exit`、`quit`。

`/help` 与 `/commands` 会把**内置 + 项目 + 用户**三层命令都列出来。自定义命令的加载规则见 [§15](#15-自定义-slash-命令)。

---

## 7. 思考等级（Thinking）

Nova 把「extended thinking」暴露成五个等级，或一个显式的 token 预算。在 DeepSeek 上，等级映射到 `output_config.effort`（而不是 Anthropic 的 `budget_tokens`）。

- 五档：`off` / `low` / `medium` / `high` / `max`（默认 `off`）
- 显式预算：传一个正整数（如 `-t 4096`），它会覆盖等级映射，直接当作 `budget_tokens`

设置方式：

- 启动时：`nova -t high "..."` 或 `nova -t 4096 "..."`
- 运行时：`/think high`（查看用 `/think`）
- 配置文件：`thinking.level` / `thinking.budgetTokens`

更深的思考通常带来更好的规划，但更慢、更贵——按任务难度调档即可。

---

## 8. Plan 模式与子 Agent

### 子 Agent

模型可以用 `createSubAgent` 工具把活儿派出去。子 agent **在进程内运行，带全新上下文**（永远看不到父对话），工具集是父 agent 的工具减去 `createSubAgent` 本身——所以**不会递归**。三种类型：

| 类型 | 工具权限 | 用途 |
|------|----------|------|
| `explore` | 只读（无 write/edit/bash） | 检索定位代码，汇报路径/调用点 |
| `plan` | 只读（无 write/edit/bash） | 调查后给出分步实现计划 |
| `general-purpose` | 完整工具 | 需要真正改文件或跑命令的活儿 |

同一轮里的多个 `createSubAgent` 调用会**并发执行**（受 `toolConcurrency` 限制）。父 agent 只会收到每个子 agent 的**最终一条消息**——庞大的中间调查被挡在主上下文之外。

通过 `settings.subagent` 配置：`enabled` / `model`（默认随父模型）/ `maxTurns`（默认 50）/ `maxTokens`（默认 32768）。每个子 agent 的 transcript 落在 `~/.nova/sessions/{id}/subagents/`。子 agent 触顶 `maxTurns` 时不再直接报错丢弃，而是追加一轮「禁用工具、立即收尾」的请求,让它基于已收集信息产出一份尽力而为的报告。

> 注：子 agent 调用 todo/task/长任务这类「有状态」工具时，操作的是**父 session** 的共享存储。

### `/plan` 命令

`/plan <goal>` 是上面机制的一层薄封装：它让 agent 派生一个 **`plan` 子 agent**，对目标做只读调查，然后返回一份分步实现计划——动手改动之前先看清楚要做什么。

---

## 9. 内置工具一览

下面是模型可调用的全部内置工具。标 **只读** 的默认自动放行；标 **需批准** 的默认走权限引擎询问（见 [§10](#10-权限与安全)）。

### 文件与文本

| 工具 | 权限 | 说明 |
|------|------|------|
| `read` | 只读 | 读文本文件，输出带 `cat -n` 风格行号（1-based）；`offset` 起始行号、`limit` 最大行数，单页另有约 20 万字符上限（超长单行整行返回、不切断），超出时提示用 `offset` 续读。行号前缀仅用于显示，传给 `edit` 前需去掉 |
| `write` | 需批准 | 写整个文件（覆盖），默认自动创建父目录 |
| `edit` | 需批准 | 精确字符串替换；`old_string` 默认须唯一匹配，`replace_all` 可全替 |
| `bash` | 需批准 | 执行短小、阻塞的 shell 命令；**硬超时 10s**，输出截到 200KB |

### 搜索与发现

| 工具 | 权限 | 说明 |
|------|------|------|
| `glob` | 只读 | 按 glob 模式列文件；默认遵守 `.gitignore`，永远跳过 `node_modules`/`.git` |
| `grep` | 只读 | ripgrep 搜内容；支持大小写/字面量/上下文行/仅列文件名等，超时 30s |

### Web

| 工具 | 权限 | 说明 |
|------|------|------|
| `webfetch` | 只读 | 取单个 http(s) URL，转成 markdown/text/html；遵守 robots.txt，默认超时 30s |
| `websearch` | 需 API key | 搜公网返回 title+url+snippet；需环境变量 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY`（按序自动选） |

### 代码智能

| 工具 | 权限 | 说明 |
|------|------|------|
| `lsp` | 只读 | 一个工具六个 action：`definition`/`references`/`hover`/`diagnostics`/`document_symbols`/`workspace_symbol`。坐标对模型是 1-based。详见 [§17](#17-lsp-代码智能) |

### 与用户交互

| 工具 | 权限 | 说明 |
|------|------|------|
| `askUserQuestion` | 只读 | 一次提 1–4 个选择题（每题 2–4 个选项，可多选）；运行时自动补一个「Other」让你自由作答 |

### 计划管理：Todo（会话内，内存态）

`createTodo` / `updateTodo` / `getTodoList` / `clearTodoList`——把多步计划外化成一张清单，**只存内存**，进程退出即丢。任一时刻最多一个 todo 处于 `in_progress`。

### 计划管理：Task（工作区内，落盘持久）

`createTask` / `updateTask` / `getTaskList` / `clearTaskList`——更大、值得跨会话保留的计划，落盘到工作区的 `.tasks/{id}.json`。支持 `blockedBy` 依赖关系，允许多个并行 `in_progress`。

### 后台长任务

| 工具 | 权限 | 说明 |
|------|------|------|
| `runLongRunningCommand` | 需批准 | 后台起一个命令（dev server / watcher 等），立即返回 id；session 退出时子进程被杀 |
| `checkLongRunningCommand` | 只读 | 查后台命令状态（`running`/`completed`/`error`）；只报状态，不回传输出 |

### Skills

| 工具 | 权限 | 说明 |
|------|------|------|
| `loadSkill` | 只读 | 按名加载某个 `SKILL.md` 的完整正文（响应上限 16KB，可配） |

### 子 Agent

| 工具 | 权限 | 说明 |
|------|------|------|
| `createSubAgent` | （派生本身放行） | 见 [§8](#8-plan-模式与子-agent)；子 agent 内部的工具调用会被重新走一遍权限 |

> MCP 桥接进来的工具以 `mcp__<服务器>__<工具>` 命名，同样受权限引擎管控（见 [§16](#16-mcp-外部工具)）。

---

## 10. 权限与安全

权限引擎（`@nova/safety` 的 `PermissionEngine`）是模型与文件系统之间的一道闸门。每次工具调用按下面的顺序裁决：

1. **危险 bash 直接拒绝。** 命令若匹配内置危险模式（`rm -r /`、fork bomb、`mkfs`、`dd if=… of=/dev/…`、重定向到块设备），立即 deny，无法绕过。
2. **运行时放行表。** 你在审批时选过「Always allow this tool」的，记在内存里，本 session 内同工具直接放行。
3. **配置规则（首个匹配生效）。** 按顺序遍历 `permissions.rules`，第一条命中的决定结果。
4. **默认效果兜底。** 都没命中就用 `permissions.defaultEffect`（默认 `ask`）。
5. **出错降级为 ask。** 规则求值若抛异常（坏正则等），降级为询问而非崩溃或拒绝——让你始终掌握控制权。

### 默认放行 vs 默认询问

- **默认放行（只读类）**：`read`/`glob`/`grep`（限定在工作区内，见下）、`webfetch`、`askUserQuestion`、所有 `get*` 查询、`checkLongRunningCommand`、`lsp`、`loadSkill`、`createSubAgent`、todo 全套。
- **默认询问（会改东西的）**：`write`、`edit`、`bash`、`runLongRunningCommand`、task 的写操作等——落到 `defaultEffect`（默认 `ask`）。

### 读操作被限定在工作区

`read`/`glob`/`grep` 的路径在裁决前会被**规范化（resolve + realpath）**，再检查是否落在「工作区根」内：

- 工作区根 = `--cwd`（或当前目录）+ `permissions.additionalDirectories` 里列出的目录。
- `..` 穿越、符号链接逃逸都会被折算成真实路径后再判断，因此 `../../etc/passwd`、`link→/etc` 这类逃逸会被正确拦下。
- `glob`/`grep` 不带 `path` 时自动注入工作区根，所以无参搜索默认就在工作区内。

### 交互式审批

需要询问时，弹出三选一：

| 选项 | 快捷键 | 效果 |
|------|--------|------|
| Allow once | `y` | 只放行这一次，下次同样的调用还会再问 |
| Deny | `n` / `Esc` | 拒绝本次调用 |
| Always allow this tool | `a` | 本 session 内该工具今后都放行（仅存内存，不写盘） |

### 自定义权限规则

在 `~/.nova/nova.config.json` 的 `permissions.rules` 里写规则数组，每条形如 `{ tool, effect, match? }`：

- `tool`：工具名，或 `"*"` 匹配任意工具
- `effect`：`allow` / `deny` / `ask`
- `match`（可选）：对输入字段的匹配条件，支持
  - **精确值**：`{ "command": "ls" }`
  - **正则**（字符串用 `/.../` 包裹）：`{ "command": "/^npm test/" }`
  - **路径包含**：`{ "path": { "within": ["/some/root"] } }`

示例：放行所有 `npm test`、拒绝带 `--data` 的 curl、其余一律拒绝：

```jsonc
{
  "permissions": {
    "defaultEffect": "ask",
    "additionalDirectories": ["/home/user/shared"],
    "rules": [
      { "tool": "bash", "effect": "allow", "match": { "command": "/^npm test/" } },
      { "tool": "bash", "effect": "deny",  "match": { "command": "/curl.*--data/" } },
      { "tool": "*",    "effect": "deny" }
    ]
  }
}
```

---

## 11. 命令沙箱

在权限引擎之上再叠一层 **OS 级纵深防御**：把会起子进程的工具（`bash`、`runLongRunningCommand`）放进操作系统沙箱里跑，把**文件写入**限制在工作区根内。底层是 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)：macOS 用 Seatbelt（`sandbox-exec`），Linux 用 bubblewrap。

要点：

- **默认开启（opt-out）。** 读放行、**网络不限制**（只管文件系统）。
- **自动降级安全。** 仅 macOS / Linux 支持；不支持的平台或缺依赖（macOS 需 `ripgrep`；Linux 还需 `bubblewrap`/`socat`）会**静默降级**为不沙箱，agent 照常运行。所以默认开是安全的；要彻底关掉设 `sandbox.enabled: false`。
- **常见缓存默认放行。** npm/pnpm/yarn/cargo/rustup/go 等工具链缓存目录已预置进白名单，常用命令开箱即用。显式设置 `filesystem.allowWrite` 会**替换**这组默认值。
- **SDK 强制保护的危险路径。** 即使在工作区里，这些也写不了：`.git/hooks`、`.git/config`、`.vscode/`、`.idea/`、`.claude/{commands,agents}`，以及 `.gitconfig`/`.zshrc`/`.mcp.json` 等 dotfile。其中只有 `.git/config` 能通过 `allowGitConfig`（默认 `true`）放行（`git config --local`、`git remote set-url` 需要它）；`.git/hooks` 始终拦。要写其它被保护路径，只能整个关掉沙箱。

配置示例：

```jsonc
{
  "sandbox": {
    "enabled": true,
    "monitorViolations": true,        // 捕获越权写并标注到命令输出（macOS 起一个 log 监听）
    "filesystem": {
      "allowWrite": ["~/.npm", "~/.cargo", "/some/extra/dir"],  // 显式设置会替换默认缓存白名单
      "denyWrite": [".env"],           // 即使在允许根内也拒绝写
      "denyRead": ["~/.ssh"],          // 读默认放行，这里单独拒绝
      "allowGitConfig": true
    }
  }
}
```

> 如果某个命令要写到工作区外的目录被拦，把对应路径加进 `filesystem.allowWrite` 即可。

---

## 12. 上下文管理与压缩

历史是 **append-only** 的：每轮只往后追加新消息，从不改写更早的内容——这既让持久化只做追加写，也让 DeepSeek 的**自动上下文缓存前缀**能持续存活。

两种压缩：

- **auto 压缩（默认开）** —— 只在上下文窗口吃紧时触发，把历史压成一条摘要消息，作为一次有意为之的「前缀重置」。可调 `compact.auto.thresholdTokens` / `contextWindowPercent` / `maxSummaryTokens`。
- **micro 压缩（默认关）** —— 每轮改写更早的 `tool_result`。它会让从改写点到结尾的缓存全部失效，而它裁掉的 token 本来就按便宜的缓存读取价计费，所以在 DeepSeek 这类有前缀缓存的 provider 上净收益「微弱到负」。**只有在没有前缀缓存的 provider 上**才建议把 `compact.micro.enabled` 设为 `true`。

手动压缩：随时 `/compact`，可附带关注点（如 `/compact 保留关于鉴权的部分`）让摘要更聚焦。

**缓存计量**：每个响应的 `cache_read_input_tokens` / `cache_creation_input_tokens` 都会累加进本 session 的用量统计，状态行能看到每轮有多少命中了缓存。

---

## 13. 记忆（Memory）

Nova 会像 CLAUDE.md 那样，把项目与用户级的记忆文件注入 system prompt。优先级与查找规则：

- **每个目录内**，按 `NOVA.md` > `CLAUDE.md` > `AGENTS.md` 取**最高优先级的那一个**——文件**不合并**。
- **项目层**：从 cwd 向上递归到仓库根，每层各取一个。
- **用户层**：依次找 `~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md`，取第一个存在的。

文件名可通过 `settings.memory.filenames` 自定义；用户层/全局路径可用 `memory.userPaths` / `memory.globalPath` 覆盖。

> 实战建议：把项目的构建/测试命令、架构约定、风格偏好写进仓库根的 `CLAUDE.md`（或 `NOVA.md`），Nova 在该仓库工作时会自动带上。

---

## 14. Skills

Skill 是「按需加载的专长说明书」。把 `SKILL.md` 放在：

- 项目层：`.nova/skills/<name>/`（兼容 `.claude/skills/<name>/`）
- 用户层：`~/.nova/skills/<name>/`（兼容 `~/.claude/skills/<name>/`）

启动时 Nova 扫描这些目录，把每个 skill 的 **name + description 索引**注入 system prompt（只占很少 token），并暴露 `loadSkill` 工具。当某个任务匹配到某个 skill 时，模型才用 `loadSkill` 拉取完整正文。

- 用 `/skills` 查看发现了哪些、各自来自哪里。
- 索引/响应大小上限：`skills.maxIndexBytes`（默认 8KB）/ `skills.maxResponseBytes`（默认 16KB）。

---

## 15. 自定义 Slash 命令

除了内置命令，你可以用 `.md` 文件定义自己的 slash 命令：

- **项目层**：`.nova/commands/`（兼容 `.claude/commands/`、`.commands/`）
- **用户层**：`~/.nova/commands/`（兼容 `~/.claude/commands/`）

规则：

- 每个 `*.md` 文件名即命令名（`deploy.md` → `/deploy`）。
- 文件前置 frontmatter 声明 `description` / arg hint / 参数；正文做占位符替换后，作为下一轮 prompt 发给模型。
- **优先级**：内置命令永远赢；项目层覆盖用户层（同名时）。
- 改了文件后用 `/commands reload` 重新扫盘，`/commands`（或 `/help`）查看当前注册了哪些。

通过 `settings.slash` 可调整开关与额外目录（`projectDirs` / `userPaths` / `extraDirs`）。

---

## 16. MCP 外部工具

Nova 可在启动时连接外部 [MCP](https://modelcontextprotocol.io) 服务器，把它们的工具以 `mcp__<服务器>__<工具>` 的形式暴露给模型，并走正常权限引擎（默认 ask）。服务器原生的 JSON Schema 原样转发，工具契约不变。

支持两种传输：本地子进程走 **stdio**，远程端点走 **http** / **sse**。

在 `~/.nova/nova.config.json` 的 `mcp.servers` 下配置：

```jsonc
{
  "mcp": {
    "enabled": true,            // 总开关（默认 true）
    "timeoutMs": 60000,         // 单次工具调用超时
    "servers": {
      "filesystem": {           // stdio（type 默认 "stdio"）
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        "env": { "FOO": "bar" }
      },
      "remote": {               // http / sse
        "type": "http",
        "url": "https://example.com/mcp",
        "headers": { "authorization": "Bearer …" }
      },
      "scratch": { "command": "…", "enabled": false }   // 单独跳过某个服务器
    }
  }
}
```

各服务器并行连接；某个连不上只会记日志并跳过——不阻塞启动、不影响其它服务器。用 `/mcp` 查看每个服务器状态和工具数，`/mcp tools` 列出所有桥接的工具名。

---

## 17. LSP 代码智能

`lsp` 工具让模型直连**语言服务器**（JSON-RPC over stdio），拿到比 grep 精确得多的导航——它懂作用域和类型。一个工具，六个 action：

| action | 作用 | 必需参数 |
|--------|------|----------|
| `definition` | 跳到定义 | `path` + `line`（+`character`，默认 1） |
| `references` | 找所有引用 | 同上（`include_declaration` 默认含声明） |
| `hover` | 某位置的类型/文档 | 同上 |
| `diagnostics` | 某文件的错误/警告 | `path` |
| `document_symbols` | 单文件符号大纲 | `path` |
| `workspace_symbol` | 按名字跨项目搜符号 | `symbol` |

- 坐标对模型是 **1-based**（行、列），内部自动转成 LSP 的 0-based。
- 工具**只读**，权限引擎默认放行。

**Nova 不安装语言服务器**——它们必须已在 PATH 上。内置自动识别四种（缺失则该语言的调用静默降级为「未安装」提示）：

| languageId | 命令 | 扩展名 |
|------------|------|--------|
| `typescript` | `typescript-language-server --stdio` | ts/tsx/mts/cts/js/jsx/mjs/cjs |
| `python` | `pyright-langserver --stdio` | py/pyi |
| `go` | `gopls` | go |
| `rust` | `rust-analyzer` | rs |

语言服务器在**首次 `lsp` 调用时按需懒启动**，所以「已安装但未启动」是正常状态。用 `/lsp` 查看每种语言：二进制是否在 PATH（● running / ○ installed / ● not installed）以及本 session 是否已起。

在配置 `lsp.servers` 里可覆盖/扩展内置表（按 `languageId` 匹配；同名整条替换，未知则追加），还可调三个超时：`initTimeoutMs` / `requestTimeoutMs` / `diagnosticsTimeoutMs`。

---

## 18. 会话、检查点与数据落盘

### 恢复与切换

- `nova -c` / `nova --continue`：恢复最近一个 session。
- `nova --resume <id>`：按 id 恢复。
- `nova --list-sessions`：列出历史 session（打印后退出）。
- REPL 内 `/resume [<id>]`：切到指定 session（不带参数则弹列表选）。

### 回退（Rewind）

`/rewind [<n>]` 回到此前某条消息——**其后的对话历史与文件改动都会被丢弃**，相当于一个检查点回滚。

### 自动清理

启动时 Nova 会删掉**最近活动超过 `sessionCleanup.maxAgeDays`（默认 30 天）**的 session 目录（按文件最新 mtime 算「最后一次使用」，不是创建时间；当前活动 session 始终受保护）。设 `sessionCleanup.enabled: false` 可永久保留。

### 数据落在哪

| 内容 | 路径 |
|------|------|
| 全局配置 | `~/.nova/nova.config.json` |
| 历史 session | `~/.nova/sessions/{id}/` |
| transcript（hook 事件流） | `~/.nova/sessions/{id}/transcript.jsonl` |
| 可重放 message 历史 | `~/.nova/sessions/{id}/messages.jsonl` |
| 子 agent transcript/message | `~/.nova/sessions/{id}/subagents/` |
| session 日志 | `~/.nova/sessions/{id}/session.log` |
| 持久化 Task | 工作区内 `.tasks/{id}.json` |

> `--no-transcript` 让本次不写 transcript；`transcript.enabled: false` 全局关闭。

---

## 19. 配置文件完整参考

配置文件位于 `~/.nova/nova.config.json`，是一份 JSON。下面列出全部字段及默认值（来自 zod schema，**每个可配项都有默认值，缺省即用默认**）。

### 顶层与模型

| 字段 | 默认 | 说明 |
|------|------|------|
| `apiKey` | （无） | provider API key（首次向导会写入） |
| `model` | `"claude-sonnet-4-5"` | 模型 id |
| `baseURL` | （无） | Anthropic 兼容端点 URL |
| `sessionDir` | （无→ `~/.nova/sessions`） | session 存放目录 |
| `maxTokens` | `32768` | 单次响应输出上限（DeepSeek 端点上限 8192，需手动调低） |
| `contextWindowTokens` | `1000000` | 上下文窗口大小（用于压缩阈值估算） |
| `maxTurns` | `40` | 单轮最大循环次数 |
| `toolConcurrency` | `3` | 单轮内工具并发上限（1 = 全串行） |

### `permissions`

| 字段 | 默认 | 说明 |
|------|------|------|
| `defaultEffect` | `"ask"` | 无规则命中时的兜底（`allow`/`deny`/`ask`） |
| `rules` | `[]` | 规则数组（首个匹配生效），见 [§10](#10-权限与安全) |
| `additionalDirectories` | `[]` | 工作区之外、读工具可免询问触及的目录 |

### `thinking`

| 字段 | 默认 | 说明 |
|------|------|------|
| `level` | `"off"` | `off`/`low`/`medium`/`high`/`max` |
| `budgetTokens` | （无） | 显式 token 预算，设了就盖过 level |

### `compact`

| 字段 | 默认 | 说明 |
|------|------|------|
| `micro.enabled` | `false` | 逐轮微压缩（DeepSeek 上不建议开） |
| `micro.keepRecent` / `minContentChars` / `preserveTools` | （内置常量） | micro 调参 |
| `auto.enabled` | `true` | 上下文吃紧时自动压缩 |
| `auto.thresholdTokens` / `contextWindowPercent` / `maxSummaryTokens` | （内置常量） | auto 调参 |

### `invariants`（工具不变量，dispatcher 强制）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `readBeforeEdit` | `true` | 编辑前必须先读过该文件 |
| `mtimeCheck` | `true` | 检测文件被外部改动（mtime 漂移） |

### 界面与体验

| 字段 | 默认 | 说明 |
|------|------|------|
| `stream.enabled` | `true` | TUI 里实时流式渲染文本/推理（仅配置项，无运行时命令） |
| `predict.enabled` | `true` | 下一条输入预测（`/predict` 切换） |
| `predict.timeoutMs` | `8000` | 预测超时 |
| `predict.maxChars` | `50` | 预测占位最大字符数 |
| `logging.level` | `"info"` | `trace`…`fatal` |
| `logging.pretty` | `true` | pretty 日志（`--no-pretty` 关） |

### 持久化

| 字段 | 默认 | 说明 |
|------|------|------|
| `transcript.enabled` | `true` | 写 transcript（`--no-transcript` 临时关） |
| `sessionCleanup.enabled` | `true` | 启动时清理旧 session |
| `sessionCleanup.maxAgeDays` | `30` | 旧 session 的天数阈值 |

### 扩展子系统

| 字段 | 默认 | 说明 |
|------|------|------|
| `memory.filenames` | `["NOVA.md","CLAUDE.md","AGENTS.md"]` | 记忆文件名优先级，见 [§13](#13-记忆memory) |
| `memory.userPaths` / `globalPath` | （无） | 覆盖用户层/全局记忆路径 |
| `slash.enabled` | `true` | 自定义 slash 命令开关；`projectDirs`/`userPaths`/`extraDirs` 额外目录 |
| `skills.enabled` | `true` | Skills 开关；`maxIndexBytes`=8192、`maxResponseBytes`=16384，及额外目录 |
| `subagent.enabled` | `true` | 子 agent 开关；`model`（默认随父）/`maxTurns`=50/`maxTokens`=32768 |
| `lsp.*` | `enabled:true` | LSP，见 [§17](#17-lsp-代码智能) |
| `mcp.*` | `enabled:true` | MCP，见 [§16](#16-mcp-外部工具) |
| `sandbox.*` | `enabled:true` | 命令沙箱，见 [§11](#11-命令沙箱) |

> 临时覆盖：`-m/--model`、`-t/--think`、`--max-turns`、`--cwd`、`--no-transcript`、`--no-pretty` 只影响本次会话，不写回文件。

---

## 20. 常见问题与排查

**Q：启动报 “Nova requires an interactive terminal (TTY)”。**
A：Nova 必须在交互式终端里跑，不支持管道/重定向/无 PTY 的 CI。换一个真正的终端。

**Q：启动报 apiKey 未设置。**
A：跑一次首启向导填上，或手动编辑 `~/.nova/nova.config.json` 的 `apiKey`/`baseURL`/`model`。

**Q：`websearch` 报缺 key。**
A：设置 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` 任一环境变量（按此顺序自动选用）。

**Q：每次写文件/跑命令都来问我，太烦。**
A：在审批框选 **Always allow this tool**（本 session 内不再问），或在 `permissions.rules` 里给具体命令/工具加 `allow` 规则（见 [§10](#10-权限与安全)）。

**Q：某条命令被沙箱拦了写入。**
A：把目标路径加进 `sandbox.filesystem.allowWrite`；若要写 `.git/hooks` 等 SDK 强制保护路径，只能 `sandbox.enabled: false` 关掉沙箱。

**Q：`lsp` 总说「未安装」。**
A：Nova 不装语言服务器。先把对应二进制装到 PATH（`typescript-language-server`/`pyright-langserver`/`gopls`/`rust-analyzer`），用 `/lsp` 确认状态。

**Q：感觉缓存没命中、变慢变贵。**
A：保持历史前缀稳定——别开 `compact.micro`（DeepSeek 上默认就关），让 append-only 历史和 auto 压缩各司其职。状态行可看每轮缓存命中量。

**Q：想回到几步之前、撤掉刚才的改动。**
A：`/rewind [<n>]` 回退到更早的消息（其后的历史与文件改动会被丢弃）。

---

*本手册依据当前代码生成。如对内部架构、loop 契约或扩展点感兴趣，请进一步阅读仓库根的 `CLAUDE.md` 与 `README.md`。*
