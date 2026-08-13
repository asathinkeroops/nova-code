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
18. [插件（Plugins）](#18-插件plugins)
19. [会话、检查点与数据落盘](#19-会话检查点与数据落盘)
20. [配置文件完整参考](#20-配置文件完整参考)
21. [常见问题与排查](#21-常见问题与排查)

---

## 1. 它能做什么

- **Agentic 编码循环** —— 给它一个目标，它自己读代码、改文件、跑命令，一步步把任务做完。同一轮里互相独立的工具调用以**有界并发**运行（默认每轮 3 个）。
- **代码与系统工具** —— 文件 read / write / edit（文本、表格、**PDF**、图片都能读），`glob` + `grep` 搜索，`bash`（含 `run_in_background` 后台长任务），web fetch / search，向你提问。
- **LSP 代码智能** —— 直连语言服务器做 go-to-definition、find-references、hover、诊断、符号搜索，比 grep 更懂作用域和类型。
- **扩展 thinking** —— 五档（`off`/`low`/`medium`/`high`/`max`）或显式 token 预算。
- **Plan 模式与子 agent** —— 把庞大的调查/规划交给全新上下文的 worker，结论汇报回来，主对话保持干净。
- **记忆、Skills、自定义命令、MCP** —— 项目/用户级的知识与工具扩展。
- **多语言** —— 模型回复语言（`language`）与 TUI 界面语言（`locale`，内置 zh-CN / EN）分开配置，默认都跟随系统 locale。
- **权限与沙箱** —— 工作区信任门 + 基于规则的拦截 + OS 级文件写入隔离，三层防护。
- **可恢复会话** —— append-only 持久化，随时 `--resume` / `--continue`，`/rewind` 回到更早节点。
- **DeepSeek 深度定制** —— thinking 映射到 DeepSeek 的 `output_config.effort`，请求结构对自动上下文缓存友好，错误码翻译与瞬时重试。

---

## 2. 安装与环境要求

环境要求：

- **Node ≥ 20**（仓库 `.nvmrc` 已固定）
- **pnpm 10.28.2**（`packageManager` 已固定）
- **交互模式**需要一个真正的**终端（TTY）**：全屏 REPL 靠它渲染。**没有 TTY**（管道、重定向、CI、git hook）时 Nova **不会报错退出，而是自动进入 headless 模式**——跑一轮就结束（见 [§4](#4-启动与命令行参数)）。

从源码运行：

```bash
pnpm install
pnpm dev                       # 启动 REPL（tsx 运行 apps/cli/src/index.ts）
pnpm dev "帮我给这个函数加单测"   # 先跑一轮 prompt，再进入 REPL
echo "总结这个 diff" | pnpm dev  # 无 TTY：headless 跑一轮后退出
```

> `pnpm dev` 是开发态入口；发布后的二进制名为 `nova`，本手册中 `nova ...` 与 `pnpm dev ...` 等价。

---

## 3. 首次配置向导

第一次启动时，如果 `~/.nova/nova.config.json` 里缺少 `apiKey`，Nova 会进入首次配置向导。它从内置 provider 模板里取一个（模板已填好 `baseURL`、默认档位、`lite`/`pro`/`max` 模型表），所以**唯一要交互问你的就是 API key**（输入时掩码）。

**当前只有 DeepSeek 一个模板对外可选**（Moonshot/Kimi 已内置但在内部测试期，暂从选择器隐藏；「Other provider」手填入口也暂时关闭）。既然只有一个 provider，向导会**跳过选择器**，直接问 DeepSeek 的 API key。它写入：

- `baseURL: https://api.deepseek.com/anthropic`
- `lite`→`deepseek-v4-flash`，`pro`/`max`→`deepseek-v4-pro`（默认档位 `pro`；三档靠 per-tier `thinking` 拉开梯度）

按 `Ctrl+C` 可中止向导。`apiKey` 已存在则跳过向导；导出了环境变量 `NOVA_API_KEY` 且配置里已有 `models` 表时同样跳过（只有环境变量、还没有 `models` 表时，向导仍会跑，但不再问你 key，也不会把这个 key 写进配置文件）。要接别的 Anthropic 兼容端点，直接**手动编辑** `~/.nova/nova.config.json`——schema 不再为 `baseURL`/`models` 提供默认值，需按 `lite`/`pro`/`max` 三档骨架填全（完整字段见 [§20](#20-配置文件完整参考)）。

> 如果启动时 `apiKey` 仍为空（且没有 `NOVA_API_KEY`），Nova 会报错退出并提示去配置文件里补上。

---

## 4. 启动与命令行参数

```bash
nova [prompt...]                   # 先跑一轮初始 prompt，再留在 REPL（交互）
  -p, --prompt <text>              # headless：跑一轮打印结果后退出（不进 REPL）
  -m, --model <tier>               # 临时切换模型档位（只认已配置档位名，如 lite/pro/max）
  -t, --think off|low|medium|high|max   # thinking 等级，或一个正整数 token 预算
      --max-turns <n>              # 单轮最大循环次数
      --cwd <dir>                  # 工具的工作目录（工作区根）
      --permission-mode default|acceptEdits|auto|plan   # 初始权限模式（默认 auto）
      --dangerously-skip-permissions   # 全自动批准（适合 CI/无人值守）
      --output-format text|json|jsonl  # headless 输出格式（默认 text）
      --resume <id>                # 恢复指定 id 的 session
  -c, --continue                   # 恢复最近一个 session
      --no-transcript              # 本次不写 transcript
      --no-pretty                  # 关闭 pretty 日志
  -v, --version                    # 打印版本后退出
```

子命令（各自独立，不进 REPL）：

```bash
nova doctor                        # 体检全局配置并打印报告（同 REPL 内 /doctor）
nova mcp …                         # 管理 MCP 服务器（连接测试、认证等，见 §16）
nova plugin …                      # 安装 / 启停 / 列出插件（见 §18）
nova upgrade                       # 跑配置里的安装器把 nova 升到最新版（见 §19）
```

要点：

- **位置参数即初始 prompt（交互）**：`nova 把 README 翻译成英文` 会先跑这一轮，再停在 REPL 等你继续。
- **`-p/--prompt` 是 headless 触发器**：跑**一轮**、打印结果、直接退出，**不进 REPL**——和位置参数不同。**没有 TTY** 时（管道 / 重定向 / CI）也会自动走 headless；此时若没给 prompt，会从 **stdin** 读取。`--output-format json|jsonl` 让 headless 输出结构化结果（`json` = 结果 + 完整消息；`jsonl` = 流式事件）。
- **`-m` / `-t` / `--max-turns` 都是本次会话的临时覆盖**，不写回配置文件。
- **`--cwd`** 决定工具的「工作区根」——读写权限、沙箱写入范围、工作区信任判定都以它为基准（见 [§10](#10-权限与安全)）。
- **首次在某个目录启动会先问「是否信任这个文件夹」**；headless 弹不出确认框，未信任的工作区直接失败退出（见 [§10](#10-权限与安全)）。

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
| `Shift+Tab` | 循环切换权限模式：default → accept edits → auto → plan（见 [§10](#10-权限与安全)） |
| `Ctrl+V` | 从剪贴板粘贴：**图片**（截图 / 复制的图）落盘后以路径形式插入并登记为附件，否则按普通文本粘贴 |
| 鼠标滚轮 | 在历史区上下滚动 |
| 鼠标拖拽 | 选中文本（用于复制） |

> 把图片文件**拖拽**到终端窗口上同样有效——路径会被规范化成绝对路径并当作附件插入。图片能否真的送进模型，取决于当前档位是否支持图像输入（见 [§9](#9-内置工具一览) `read`）。

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

### `@path` 文件引用补全

在输入框里打一个 `@` 开头的词，会弹出**工作区文件路径**补全。文件清单与 `glob`/`grep` 看到的一致：遵守 `.gitignore`（逐层向仓库根收集）、跳过 `node_modules`/`.git`、不含隐藏文件，最多 10000 条。

排序由具体到宽泛：**文件名前缀命中** > 文件名内含 > 整条路径内含，同分则短路径优先。`↑`/`↓` 选择，`Enter` / `Tab` 补全——补全只替换那个 `@…` 词，**不会提交**。命令行（`/` 开头）上只弹 slash 命令补全，不触发 `@`。

### `!` shell 直通

以 `!` 开头的一行**不发给模型**，直接在 shell 里跑（输入框边框会变绿提示）。它复用 `bash` 工具：同样在工作区根执行、同样受 OS 沙箱约束（见 [§11](#11-命令沙箱)），输出以一张卡片贴回历史区，`Esc` 可中断。因为是你自己敲的命令，**不走权限门**。

它和 `/` 命令行一样带本地副作用，所以即使在回合运行中键入也**始终排队**、由 REPL 在空闲时派发——不会被 `queue.consumeInLoop` 折进当前回合（见 [§20](#20-配置文件完整参考)）。

### 状态行

输入框下方两行实时状态：

- **第一行**：模型档位 + 思考等级 + 上下文窗口、上下文占用进度条与百分比、工作区目录名、git 分支、完整 cwd。
- **第二行（用量）**：账户余额（仅接 DeepSeek 官方 API 时出现；账户不可扣费时转为琥珀色）、缓存命中率、累计输入 / 输出 token、按当前档位 `pricing` 估算的花费。终端过窄时从右往左丢弃分段，余额和命中率优先保留。
  - 缓存分段给两个数字：`缓存 90% 会话 99% 累计` —— 前者是**本会话**（从 transcript 重放，扛得住重启和 `/resume`）的命中率，后者是**跨会话累计**的命中率，`/clear`、换会话、重装都不归零。累计值记在 `~/.nova/usage.json`（每请求批量累加、原子写，多个 nova 进程会各自并入而不是互相覆盖），而不是启动时去扫 `~/.nova/sessions/*` —— 旧会话目录会被 `sessionCleanup.maxAgeDays` 清掉，扫出来的历史本来就不全。哪一半还没有数据就只显示另一半。

### 界面语言（i18n）

- `settings.language` 决定**模型回复语言**（注入 system prompt），默认 `auto` —— 跟随系统 locale（`$LC_ALL`/`$LANG`/`$LANGUAGE`，macOS 还会读 `AppleLocale`）。
- `settings.locale` 只覆盖 **TUI 静态文案**（菜单、提示、状态行），默认 `auto` 即跟随 `language`。内置 zh-CN 与 EN 两套文案，不认识的标签一律回落到英文。
- 两者可以不同——比如中文界面 + 英文回复：`{"locale": "zh-CN", "language": "en"}`。改动需重启生效（语言写进 system prompt，会话中途变更会击穿前缀缓存）。

### 输入预测

每成功跑完一轮，Nova 会用主模型预测你**下一句可能想说什么**，作为输入框的灰色占位提示（默认开启，超时 8s，最多 300 字）。用 `/predict on|off` 开关，或在配置里调 `predict`。

---

## 6. Slash 命令大全

在输入框里以 `/` 开头即触发。内置命令永远优先于自定义命令。

| 命令 | 作用 |
|------|------|
| `/help` | 显示帮助；列出按来源分组（Built-in / Project / User）的命令 |
| `/effort [<level>]` | 查看或切换 thinking 等级（`off`/`low`/`medium`/`high`/`max` 或整数预算） |
| `/model [<tier>]` | 查看或切换当前会话的**模型档位**（`lite`/`pro`/`max` 等已配置档位，仅本次会话不持久化）；只接受配置过的档位名，裸模型 id 会被拒绝；无参数弹出交互列表 |
| `/clear` | 清空当前会话历史（session 仍保留） |
| `/rename [<name>\|clear]` | 给当前 session 起个名字（显示在输入框边框上）；`clear` 清除 |
| `/compact [focus…]` | 把历史压缩成单条摘要消息；可附带关注点提示 |
| `/resume [<id>]` | 切换到指定 session；不带参数则弹出列表选择 |
| `/rewind [<n>]` | 回退到此前某条消息——其后的对话历史与文件改动都会被丢弃 |
| `/plan <goal>` | 把调查交给一个只读的 plan 子 agent，返回分步实现计划 |
| `/goal [<condition>\|clear]` | 设定一个成功条件，Nova 自动推进直到达成；`clear` 取消 |
| `/diff [pathspec]` | 交互式浏览未提交变更，选中后查看语法高亮差异（只读） |
| `/review [focus…]` | 审查当前未提交的 diff，只读地报告问题（不改动任何文件） |
| `/review <PR#\|#PR\|PR-URL> [focus…]` | 通过 `gh` CLI 只读审查某个 GitHub PR（`gh pr view` / `gh pr diff`）；`gh` 缺失或未登录会明说并停下 |
| `/init [focus…]` | 探索代码库后生成 / 刷新项目记忆（`NOVA.md`） |
| `/agents [reload]` · `/agent <name> <task>` | 列出子 agent 类型 / 委派一项任务 |
| `/nova-code-guide <question>` · `/nova-code-guide-update` | 就 Nova 自身答疑的只读 Q&A 子 agent；`-update` 拉取 / 刷新它读取的 Nova 源码 |
| `/loop <interval> <prompt\|/cmd>` | 按固定间隔重复投递某条 prompt 或命令；`/loop stop` 停止，`/clear`/`/resume`/退出 亦终止（配置见 [§20](#20-配置文件完整参考) `loop.*`） |
| `/doctor` | 体检全局配置（JSON/schema、模型/key、项目 hook 文件、MCP 摘要）并在弹窗里报告；按 `f` 把问题交给 agent 就地修复 |
| `/usage` · `/context` | 累计 token 用量与缓存命中 / 上下文窗口占用可视化 |
| `/predict [on\|off]` | 查看或切换「下一条输入预测」 |
| `/commands [reload]` | 列出已注册的 slash 命令；`reload` 重新扫盘加载自定义命令 |
| `/skills` | 列出已发现的 `SKILL.md`（及各自来源） |
| `/mcp [tools]` | 打开 MCP 服务器菜单（认证 / 重连 / 登出，见 [§16](#16-mcp-外部工具)）；`tools` 列出所有桥接的工具 |
| `/lsp` | 查看已配置的语言服务器（是否在 PATH、本 session 是否已启动） |
| `/plugin` | 列出已加载的插件及其贡献（安装 / 启停用 `nova plugin` CLI，见 [§18](#18-插件plugins)） |
| `/sandbox [on\|off]` | 本会话内开关 OS 命令沙箱（见 [§11](#11-命令沙箱)） |
| `/tasks [list\|stop <id\|all>]` | 查看和管理后台命令（`bash` + `run_in_background`），支持 list / stop |
| `/exit`, `/quit` | 退出 |

`/help` 与 `/commands` 会把**内置 + 项目 + 用户**三层命令都列出来。`/model` 只按已配置的档位名切换（如 `/model pro`），裸模型 id 会被拒绝。自定义命令的加载规则见 [§15](#15-自定义-slash-命令)。

---

## 7. 思考等级（Thinking）

Nova 把「extended thinking」暴露成五个等级，或一个显式的 token 预算。在 DeepSeek 上，等级映射到 `output_config.effort`（而不是 Anthropic 的 `budget_tokens`）。

- 五档：`off` / `low` / `medium` / `high` / `max`
- 显式预算：传一个正整数（如 `-t 4096`），它会覆盖等级映射，直接当作 `budget_tokens`

**思考等级是 per-tier（按档位）的属性，没有全局 `thinking` 配置项**——它写在 `models.<tier>.thinking` 里，切档（`/model`）会把当前思考等级换成该档的值。这也是 lite/pro/max 能在同一个模型 id 上拉出能力梯度的原因（DeepSeek 模板：lite→`low`、pro→`high`、max→`max`）。档位没写 `thinking` 时回退到 `max`。

设置方式：

- 启动时：`nova -t high "..."` 或 `nova -t 4096 "..."`（本次会话的临时覆盖）
- 运行时：`/effort high`（查看用 `/effort`）——会写回当前档位，在本会话内生效
- 持久：直接改配置里该档的 `models.<tier>.thinking`

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
| `nova-code-guide` | 只读（限于 Nova 源码检出） | 就 Nova 自身答疑（`/nova-code-guide`，见 [§6](#6-slash-命令大全)） |

同一轮里的多个 `createSubAgent` 调用会**并发执行**（受 `toolConcurrency` 限制）。父 agent 只会收到每个子 agent 的**最终一条消息**——庞大的中间调查被挡在主上下文之外。

通过 `settings.subagent` 配置：`enabled` / `model` / `maxTurns`（默认 100）/ `maxTokens`（默认 32768）。`model` 是一张**按子 agent 名索引的表**（如 `{"plan":"max","explore":"pro"}`），可给每个 agent 单独指定模型档位；解析顺序由具体到宽泛：该表的对应条目 → 内置默认（`general-purpose`/`plan`→`max`，`explore`/`nova-code-guide`→`pro`）→ 自定义 agent 自己 frontmatter 里的 `model` → 当前主模型。整张表省略则全部沿用默认。每个子 agent 的 transcript 落在 `~/.nova/sessions/{id}/subagents/`。子 agent 触顶 `maxTurns` 时不再直接报错丢弃，而是追加一轮「禁用工具、立即收尾」的请求,让它基于已收集信息产出一份尽力而为的报告。

> 注：子 agent 调用 todo/task/长任务这类「有状态」工具时，操作的是**父 session** 的共享存储。

### `/plan` 命令

`/plan <goal>` 是上面机制的一层薄封装：它让 agent 派生一个 **`plan` 子 agent**，对目标做只读调查，然后返回一份分步实现计划——动手改动之前先看清楚要做什么。

---

## 9. 内置工具一览

下面是模型可调用的全部内置工具。标 **只读** 的默认自动放行；标 **需批准** 的默认走权限引擎询问（见 [§10](#10-权限与安全)）。

### 文件与文本

| 工具 | 权限 | 说明 |
|------|------|------|
| `read` | 只读 | 读**文本 / 表格 / PDF / 图片**：文本输出带 `cat -n` 风格行号（1-based），`offset` 起始行、`limit` 最大行数，单页约 20 万字符上限、单行超 1.6 万字符会截断并标注，超出时提示用 `offset` 续读；行号前缀仅用于显示，传给 `edit` 前需去掉。表格（`.xlsx/.xls/.xlsm/.xlsb/.ods`）每行渲成 TSV 带表头，`sheet` 选工作表。**PDF**（`.pdf`，≤30MB）抽取文本后同样带行号返回，每页前插一条 `[Page N]` 标记，`offset`/`limit` 照常分页；扫描件 / 纯图片 PDF 抽不出文本，会明说并建议改用 OCR 工具。图片（`.png/.jpg/.jpeg/.gif/.webp`，≤20MB）以 base64 块返回——**仅当前档位支持图片输入时**（否则提示切到 image-capable 档位）。含 NUL 字节的二进制文件直接拒读并给出 `file`/`xxd` 建议 |
| `write` | 需批准 | 写整个文件（覆盖），默认自动创建父目录 |
| `edit` | 需批准 | 精确字符串替换；`old_string` 默认须唯一匹配，`replace_all` 可全替 |
| `bash` | 需批准 | 执行 shell 命令（`bash -lc`）。默认阻塞：`timeout_ms` **默认与上限都是 180000（3 分钟）**，`cwd` 可覆盖工作目录，输出截到 200KB。更长的任务传 `run_in_background: true`——命令转入后台、立即返回 `{id, pid, output_path}`，`env` 可追加环境变量 |

### 搜索与发现

| 工具 | 权限 | 说明 |
|------|------|------|
| `glob` | 只读 | 按 glob 模式列文件；默认遵守 `.gitignore`，永远跳过 `node_modules`/`.git` |
| `grep` | 只读 | ripgrep 搜内容；支持大小写/字面量/上下文行/仅列文件名等，超时 30s |

### Web

| 工具 | 权限 | 说明 |
|------|------|------|
| `webfetch` | 只读 | 取单个 http(s) URL，转成 markdown/text/html；遵守 robots.txt，默认超时 30s |
| `websearch` | 需 API key | 搜公网返回 title+url+snippet；需配置 `websearch.braveApiKey` / `tavilyApiKey` / `serperApiKey`，或对应环境变量 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY`（按序自动选） |

### 代码智能

| 工具 | 权限 | 说明 |
|------|------|------|
| `lsp` | 只读 | 一个工具六个 action：`definition`/`references`/`hover`/`diagnostics`/`document_symbols`/`workspace_symbol`。坐标对模型是 1-based。详见 [§17](#17-lsp-代码智能) |

### 与用户交互

| 工具 | 权限 | 说明 |
|------|------|------|
| `askUserQuestion` | 只读 | 一次提 1–4 个选择题（每题 2–4 个选项，可多选）；运行时自动补一个「Other」让你自由作答 |
| `enterPlanMode` | 默认放行 | 模型把**当前会话**切进只读的 `plan` 权限模式（与 <kbd>Shift+Tab</kbd> 切到的那一档是同一个开关）。只会收权，所以不问你；界面上显示为一行 `plan  read-only`，标出会话是从哪里开始只读的 |
| `exitPlanMode` | 默认放行 | 带上完整方案（markdown）请你拍板，直接弹一个「按这个计划动手吗？」的选择框。它的调用行**不显示**，取而代之的是 `plan` 参数**当作模型正文渲染出来**——那正是要你拍板的东西（模型若已在正文里写过同一份方案，则不重复渲染）。**只有你明确同意**才关掉 plan 模式（回到进入前的那个模式，没记录则回 `default`）；选「Other」写的意见会作为反馈回给模型，plan 模式保持开着 |

模型自己进出 plan 模式这套由 `planMode.agentTools` 控制（默认开）。关掉后这两个工具不再注册，plan 模式就只能靠 <kbd>Shift+Tab</kbd> 或 `--permission-mode plan` 手动进。子 agent 永远拿不到这两个工具——它跑在主会话里，不该去改主会话的权限模式。

**不过退出 plan 模式并不依赖模型调 `exitPlanMode`**：只要一轮结束时还在 plan 模式，nova 自己就会弹那个确认框（`planMode.approvalGate`，默认开），见 [§10](#10-权限与安全)。


### 计划管理：Todo（会话内，内存态）

`createTodo` / `updateTodo` / `getTodoList` / `clearTodoList`——把多步计划外化成一张清单，**只存内存**，进程退出即丢。任一时刻最多一个 todo 处于 `in_progress`。全部完成后清单会在 `todo.autoClearDelayMs`（默认 2.5s，留一拍让你看到那排 ✓）后自动清空，不指望模型自己去调 `clearTodoList`。

### 计划管理：Task（工作区内，落盘持久）

`createTask` / `updateTask` / `getTaskList` / `clearTaskList`——更大、值得跨会话保留的计划，落盘到工作区的 `.tasks/{id}.json`。支持 `blockedBy` 依赖关系，允许多个并行 `in_progress`。整份计划做完后同样会在 `task.autoClearDelayMs`（默认 2.5s）后自动清空并删掉对应的 `.tasks/` 文件。

### 定时调度：Cron（会话内，落盘持久）

| 工具 | 权限 | 说明 |
|------|------|------|
| `cronCreate` | 只读放行 | 把一条 prompt 或 `/command` 排进定时表——`schedule` 支持**重复间隔**（`30s`/`5m`/`1h`）或**标准 5 字段 cron 表达式**（`0 9 * * *` 每天 9 点、`*/15 * * * *` 每 15 分钟）；可选 `label`、`maxIterations` |
| `cronList` / `cronDelete` | 只读放行 | 列出 / 删除定时表条目 |

定时条目落盘在 `~/.nova/sessions/{id}/cron/`，`/resume` 时重新装载并重排，`/clear` 时清空。**只有会话活着时才会触发**（没有后台守护进程）——到点的 tick 若正好有回合在跑，会等 REPL 空闲后立刻补跑，不会重叠堆积。三个工具本身默认放行（只是登记元数据），但**排定的 payload 真正动手时仍在触发那一刻走完整权限门**。`/loop` 就是基于这套机制的薄封装（见 [§6](#6-slash-命令大全)）。配置见 [§20](#20-配置文件完整参考) `cron.*`。

### 后台长任务

| 工具 | 权限 | 说明 |
|------|------|------|
| `bash`（`run_in_background: true`） | 需批准 | 后台起一个命令（dev server / watcher 等），立即返回 `{id, pid, output_path}`；session 退出时子进程被杀 |
| `killBackground` | 需批准 | 终止一个后台命令 |
| `monitor` | 需批准 | 起一个**监听脚本**：它 stdout 的**每一行**都会变成一条通知推给模型。用于 `tail -f`、`inotifywait -m`、轮询循环等「每次发生都要知道」的场景。返回 `{id, pid, watching, persistent, log_path}` |
| `stopMonitor` | 只读 | 按 id 停掉一个监听 |

**`monitor` 和后台命令的分工，按「你要被通知几次」划分**：只要**一次**（构建结束、服务起来了）用 `bash` + `run_in_background`，配一个条件满足就退出的命令（`until grep -q 'ready' dev.log; do sleep 0.5; done`）；**每次发生都要**用 `monitor`。用 `tail -f` 去做「只通知一次」是典型误用——事件早触发了，监听还挂到超时。

过滤要写在命令里（`grep -E --line-buffered`），而且**必须覆盖失败**：只匹配成功标记的过滤器在崩溃、hang、OOM 时同样一声不吭，而沉默和「还在跑」无法区分。stderr **不是**事件流，只进 `log_path`，需要它触发通知就 `2>&1` 合并。

事件量受 `settings.monitor` 限流：超过 `maxEventsPerWindow`（默认 60 条/分钟）的监听会被**直接杀掉**并在通知里说明——静默限流会让模型误以为自己仍在被完整告知。未消费队列上限 `maxQueuedEvents`（默认 200），溢出丢**最旧**的并报告丢弃条数。`persistent: true` 的监听没有超时，随会话结束才停；`/tasks` 里能看到并 `stop`。


后台命令没有专门的读取工具：`output_path` 指向 `~/.nova/sessions/{id}/background/{命令id}.log`，这是命令 stdout+stderr 的**完整**日志，用普通的 `read` / `grep` 跟读即可（该目录已默认放行，不会每次弹权限）。

命令结束时会由 `<background-notification>` 自动注入一条**公告**——只带 id、状态、退出原因和日志路径，**不内联输出**：

```xml
<background-notification id="a1B2c3" command="pnpm dev" status="error"
                     output="~/.nova/sessions/{id}/background/a1B2c3.log">[exited with code 1]
Output: … — read or grep it if you need the command's output.</background-notification>
```

这样输出**只有一条投递通道**（文件）。若通知里也内联一份，模型自己 `read` 过的内容就会被重复推送一遍，而且一个跑久的 dev server 结束时可能一次性往 append-only 历史里灌进上百 KB。状态和退出原因留在通知里，已经足够模型判断要不要再花一轮去读日志。

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

### 工作区信任（启动前的第一道门）

在任何工具能跑起来之前，Nova 先确认你**允许它访问当前这个文件夹**。首次在某个目录启动时会占满屏幕弹一张确认卡片，选 Yes 才继续，选 No / `Esc` 直接退出。

- 信任记录写在**用户全局配置** `~/.nova/nova.config.json` 的 `trust.trustedRoots`（绝对、符号链接已解析的路径），**从不写进项目内的文件**——所以 clone 下来的仓库无法把自己标记为可信。
- 判定是**包含关系**：工作区等于或位于某个已记录根之下即视为可信，因此信任仓库根即覆盖其所有子目录。
- **家目录例外**：对 `~` 授予的信任只在本次会话有效，不落盘。
- **headless（`-p` / 无 TTY）没法弹确认框**，所以未信任的工作区是**硬性拒绝**：先交互式跑一次并信任、或手工把路径加进 `trust.trustedRoots`、或传 `--dangerously-skip-permissions` 绕过。
- 写配置失败不会中断会话（你已经同意了，本次有效，只是下次还会再问）。设 `trust.enabled: false` 可恢复「启动即信任」的旧行为。

### 权限引擎

权限引擎（`@nova/safety` 的 `PermissionEngine`）是模型与文件系统之间的一道闸门。每次工具调用按下面的顺序裁决：

1. **危险 bash 直接拒绝。** 命令若匹配内置危险模式（`rm -r /`、fork bomb、`mkfs`、`dd if=… of=/dev/…`、重定向到块设备），立即 deny，无法绕过。
2. **运行时放行表。** 你在审批时选过「Always allow this tool」的，记在内存里，本 session 内同工具直接放行。
3. **配置规则（首个匹配生效）。** 按顺序遍历 `permissions.rules`，第一条命中的决定结果。
4. **默认效果兜底。** 都没命中就用 `permissions.defaultEffect`（默认 `ask`）。
5. **出错降级为 ask。** 规则求值若抛异常（坏正则等），降级为询问而非崩溃或拒绝——让你始终掌握控制权。

### 默认放行 vs 默认询问

- **默认放行（只读或仅登记元数据的）**：`read`/`glob`/`grep`（限定在工作区内，见下）、`webfetch`、`websearch`、`askUserQuestion`、`lsp`、`loadSkill`、`createSubAgent`、`killBackground`、**todo 全套**、**task 全套**（含写操作 create/update/clear）、**cron 全套**（`cronCreate`/`cronList`/`cronDelete`）、`enterPlanMode`/`exitPlanMode`。task/cron 的写只改自己的清单/排程，payload 真正动手时仍走权限门，所以放行它们不越权；plan 两件套同理——进只收权，出自带一道确认。
- **默认询问（会改文件 / 跑命令的）**：`write`、`edit`、`bash`（前台和 `run_in_background` 一视同仁）——落到 `defaultEffect`（默认 `ask`）。

> `permissions.deny`（裸工具名数组）是更强的一档：列进去的工具会在启动时从注册表**摘除**，模型根本看不到、也调不了（区别于 `rules` 里 `effect: "deny"`——后者仍把工具报给模型、只在调用时拒）。

### 权限模式（Shift+Tab 切换）

输入框右下角有一个**权限模式**指示，按 `Shift+Tab` 在四档间循环（`bypassPermissions` 仅在 `--dangerously-skip-permissions` 启用后才加入循环）。它在权限引擎之前介入，临时改变写类工具的裁决倾向——只影响当前会话、不写盘：

| 模式 | 状态行 | 行为 |
|------|--------|------|
| `default` | ○ manual mode on（浅灰） | 不改变任何裁决，`write`/`edit`/`bash` 照常落到引擎的 `ask` |
| `acceptEdits` | ⏵⏵ accept edits on（绿） | **工作区内**的 `write`/`edit` 自动放行；`bash` 与工作区外的写仍然询问 |
| `auto`（启动默认） | ✦ auto mode on（琥珀） | **自主模式**：在 `acceptEdits` 基础上，命令工具（`bash`，含 `run_in_background`）也自动放行、无人值守运行（先过一层风险分类器）。比 `acceptEdits` 更宽，但仍窄于 `bypassPermissions`——工作区外的写和用户 `deny` 规则不被绕过 |
| `plan` | ⏸ plan mode on（青） | **只读**：`write`/`edit`/`bash` 一律拒绝，逼模型先调查、给出分步计划——与只读 `/plan` 子 agent 同源 |

`plan` 这一档模型自己也能进：`enterPlanMode` 让它在动手前先切成只读（只收权，不问你）。整套由 `planMode.agentTools` 控制，默认开；见 [§9](#9-内置工具一览)。模式无论谁切的，都会在下一次请求时以一条 `<plan-mode>` 提示告诉模型，行为完全一致。

**退出则不靠模型自觉。** 只要一轮结束时会话还停在 plan 模式，nova 在回到输入框之前会自己弹确认框：

- 选**同意** → 权限模式立刻回到**进入 plan 之前的那一档**（shift+tab 进的也记得，例如从 `auto` 进就回 `auto`），并立刻续跑一轮开始实现，你不用再输入任何东西
- 选**不同意** → 留在 plan 模式；你在「Other」里写的意见直接作为下一轮输入回给模型
- **ESC 关掉** → 什么也不做，回到输入框（shift+tab 和直接打字都照常）

模型主动调 `exitPlanMode` 弹的是同一个框、同一套恢复逻辑；那一轮里已经问过，闸门就不会再问第二遍。这一层由 `planMode.approvalGate` 控制（默认开），关掉则退出 plan 模式回到只靠 `exitPlanMode` 或 <kbd>Shift+Tab</kbd>。

不指定时启动即为 `auto`；用 `--permission-mode` 可指定别的初始档位，`--dangerously-skip-permissions` 直接进入 `bypassPermissions`（每次审批自动放行，适合 CI/无人值守）。

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

在权限引擎之上再叠一层 **OS 级纵深防御**：把会起子进程的工具（`bash`，前台和后台两条路径都算）放进操作系统沙箱里跑，把**文件写入**限制在工作区根内。底层是 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)：macOS 用 Seatbelt（`sandbox-exec`），Linux 用 bubblewrap。

要点：

- **默认关闭（opt-in）。** 需显式设 `sandbox.enabled: true` 才开启（或会话内 `/sandbox on`）。开启后读放行；**网络默认不限制**（只管文件系统），但可选 `network.allowedDomains` / `deniedDomains` 收紧出站连接（见 [§20](#20-配置文件完整参考)）。
- **自动降级安全。** 仅 macOS / Linux 支持；不支持的平台或缺依赖（macOS 需 `ripgrep`；Linux 还需 `bubblewrap`/`socat`）会**静默降级**为不沙箱，agent 照常运行。
- **常见缓存默认放行。** npm/pnpm/yarn/cargo/rustup/go 等工具链缓存目录、以及 `~/.config/gh`（gh/PR 工作流下 token 刷新）已预置进白名单，常用命令开箱即用。显式设置 `filesystem.allowWrite` 会**替换**这组默认值。
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

**auto 压缩（默认开）**：只在上下文窗口吃紧时触发。它不截断历史，而是往 append-only 历史里**追加一条 `<compacted>` 摘要边界**——完整历史仍留在磁盘、TUI 里照旧全量渲染，只有喂给**模型**的视图缩短到「最后一条边界往后」。这是一次有意为之的「前缀重置」：边界之内前缀依旧稳定命中缓存，边界推进时才重置一次。可调 `compact.auto.enabled` / `thresholdTokens` / `contextWindowPercent` / `maxSummaryTokens`。

触发阈值默认是**上下文窗口的 90%**（`contextWindowPercent`，或用 `thresholdTokens` 钉死一个绝对值）。这个 90% 算的是**整个请求**——system 提示词、记忆、skills 索引、工具 schema，加上对话消息，和 `/context` 面板显示的口径一致。固定开销通常在一万多 token，窗口越小占比越高，所以把它计入触发判断是必要的：只按消息量算的话，128k 窗口下等阈值触发时真实请求已经超出窗口了。

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

### 自动记忆（agent 自维护，跨会话）

除了你手写的记忆文件，Nova 还维护一层 **auto 记忆**——agent 自己在工作中沉淀下来的事实，跨会话保留：

- 落在全局用户目录、按项目分目录：`~/.nova/projects/<项目路径编码>/memory/`（与 Claude Code 一致；可用 `memory.auto.dir` 改成工作区内路径）。里面是一个 `MEMORY.md` 索引，加上**每条事实一个文件**。
- **索引**（`MEMORY.md`，每条一行）注入 system prompt，占很少 token；单条事实正文由 agent 按需 `read`。为控制每请求成本，注入的索引条数上限 `memory.auto.maxEntries`（默认 100）。
- 这个目录归 agent 所有：其中的 `read`/`write`/`edit` **默认放行、不弹权限**（见 [§10](#10-权限与安全)）——沉淀一条学到的事实不该每次都问你。
- 默认放在全局用户目录、按项目标识分目录：记忆随项目走但不污染仓库；若想改为随项目 git 跟踪，把 `memory.auto.dir` 设为工作区内相对路径（如 `.nova/memory`）即可。
- 用 `memory.auto.enabled: false` 关闭整层。

---

## 14. Skills

Skill 是「按需加载的专长说明书」。把 `SKILL.md` 放在：

- 项目层：`.nova/skills/<name>/`（兼容 `.claude/skills/<name>/`）
- 用户层：`~/.nova/skills/<name>/`（兼容 `~/.claude/skills/<name>/`）

启动时 Nova 扫描这些目录，把每个 skill 的 **name + description 索引**注入 system prompt（只占很少 token），并暴露 `loadSkill` 工具。当某个任务匹配到某个 skill 时，模型才用 `loadSkill` 拉取完整正文。

- 用 `/skills` 查看发现了哪些、各自来自哪里。
- 索引预算：默认取**当前模型上下文窗口的 1%**（按 4 字节/token 折算），`skills.indexBudgetFraction` 可调。200k 窗口约 8000 字节，1M 窗口自动放大到 40000。想钉死一个绝对值就设 `skills.maxIndexBytes`，它优先于比例。
- 索引里单条描述的上限：`skills.maxDescriptionBytes`（默认 1536 字节，超出以 `…` 标记）。这只影响索引条目，`SKILL.md` 里的完整 description 不受影响。
- **超预算时不会丢技能**，而是把条目降级成只剩名字（`- name`），按代价从小到大尽量多保留描述。名字还在就仍然能被 `loadSkill` 调起，而完整正文本来就要靠 `loadSkill` 拉。
- 响应大小上限：`skills.maxResponseBytes`（默认 16KB）。
- 单个 `SKILL.md` 的磁盘上限：`skills.maxFileBytes`（默认 1MB）。超限的文件在 `stat` 阶段就被跳过并 warn，不会读进内存。
- 技能目录可以是**符号链接**（用来在多个 checkout 之间共享同一份技能），会被正常跟随；链接指向非目录时静默忽略。

**Front-matter**：只有三件事会让一个 `SKILL.md` 被拒收 —— 缺 `---` 块、缺 `name`（必须匹配 `^[a-z][a-z0-9-]*$`）、缺 `description`。Nova 认得的字段：

| 字段 | 作用 |
| --- | --- |
| `name` | 技能名，同时是 `/{name}` 命令名 |
| `description` | 模型据此判断何时该用；原样注入，不截断 |
| `when_to_use` | 补充触发条件，拼接到 `description` 之后 |
| `disable-model-invocation` | `true` 时不进模型索引，只能用户 `/{name}` 手动调用 |
| `user-invocable` | `false` 时不注册 `/{name}`，只能模型自主调用 |

其余字段（`allowed-tools`、`hooks`、`model` 等）会被**解析后忽略**，不会导致加载失败 —— 这样为其它 agent 运行时写的技能可以原样放进来。front-matter 走标准 YAML 子集：嵌套映射、块序列、`[a, b]` / `{a: 1}` 流式集合、`|` / `>` 块标量、折行的多行标量、`#` 注释都支持。

**两条调用路径**：

| 谁调的 | 怎么走 | 参数 |
| --- | --- | --- |
| 模型自己 | 匹配到索引里的 description → 调 `loadSkill` 工具 → 拿到展开后的正文 | 无（工具只收技能名） |
| 你敲 `/{name} 参数` | 直接读盘、展开、作为下一轮 prompt 注入（一跳，不经过工具） | `$ARGUMENTS` / `$1`..`$N` 绑定你敲的内容 |

两条路都经由同一个渲染函数，模型看到的文本逐字节一致 —— 一个技能不会因为「谁调它」而表现不同。`/{name}` 每次调用都重新读盘，所以改完 `SKILL.md` 直接再敲一次就生效，不用 `/commands reload`（那个只在增删技能目录时才需要）。

**正文里的变量与插值**：按顺序做四层展开，和自定义 slash 命令用的是同一套实现。

| 写法 | 展开成 |
| --- | --- |
| `${CLAUDE_SKILL_DIR}` / `${NOVA_SKILL_DIR}` | 该技能自己的目录绝对路径 |
| `${CLAUDE_PROJECT_DIR}` / `${NOVA_PROJECT_DIR}` | 当前工作区根目录 |
| `${CLAUDE_PLUGIN_ROOT}` / `${NOVA_PLUGIN_ROOT}` | 技能所属插件的根目录（仅插件提供的技能有） |
| `${CLAUDE_SESSION_ID}` / `${NOVA_SESSION_ID}` | 当前会话 ID |
| `${CLAUDE_EFFORT}` / `${NOVA_EFFORT}` | 当前思考等级（`off`/`low`/`medium`/`high`/`max`），随 `/effort` 变化 |
| `$ARGUMENTS` / `$ARGUMENTS[n]` / `$1`..`$N` | 你在 `/{name}` 后面敲的内容；模型走 `loadSkill` 时这些占位符**原样保留**（没有参数可绑） |
| `@相对路径` | 内嵌该文件内容（上限 100KB，超出截断）；解析不到文件就原样保留，所以邮箱和 `@scope/pkg` 安全 |
| `` !`命令` `` | 执行并内嵌输出，走 bash 工具和沙箱；设 `skills.disableShellExecution: true` 后替换为一行提示且不执行 |

不认识的 `${NAME}` 原样保留（别的工具的变量不会被抹成空），小写的 `${name}` 完全不动（JS 模板字符串示例不会被误伤）。取不到值的变量（非插件技能的 `${CLAUDE_PLUGIN_ROOT}`、无会话时的 `${CLAUDE_SESSION_ID}`）同样保持原样而不是变空，这样「不适用」和「解析成空」能区分开。展开顺序是变量 → 参数 → `@` → `` ! ``，每层的产物喂给下一层，所以 `@${NOVA_SKILL_DIR}/ref.md` 和 ``!`grep $1 file` `` 都能用。

---

## 15. 自定义 Slash 命令

除了内置命令，你可以用 `.md` 文件定义自己的 slash 命令：

- **项目层**：`.nova/commands/`（兼容 `.claude/commands/`、`.commands/`）
- **用户层**：`~/.nova/commands/`（兼容 `~/.claude/commands/`）

规则：

- 每个 `*.md` 文件名即命令名（`deploy.md` → `/deploy`）。
- 文件前置 frontmatter 声明 `description` / arg hint / 参数；正文做占位符替换后，作为下一轮 prompt 发给模型。
- 正文支持的参数写法：`{{name}}` / `{{name|默认值}}`（Nova 原生）、`$ARGUMENTS`、`$ARGUMENTS[n]`（**0 起**）、`$1`..`$N`（**1 起**，`$1` 是第一个）、`$name`（取 `args:` 声明的具名参数，和 `{{name}}` 同源同值）、`\$` 转义。另外还有 `@路径` 内嵌文件和 `` !`命令` `` 插值。
- **敲了参数但正文里一个占位符都没命中**时，参数会以 `ARGUMENTS: ...` 追加到末尾，而不是被丢掉。
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

各服务器并行连接；某个连不上只会记日志并跳过——不阻塞启动、不影响其它服务器。`/mcp` 打开一个**菜单**（认证 / 重连 / 登出，查看状态和工具数），`/mcp tools` 列出所有桥接的工具名；shell 里也有 `nova mcp` 子命令。

### OAuth（远程服务器鉴权）

对以 401/403 挑战的远程 http/sse 服务器，Nova 支持 **OAuth 2.0（authorization-code + PKCE）**：

- 给该服务器加一个 `oauth: {}` 块（可选 `scope`）即启用；`mcp.oauth.autoDetect`（默认 `true`）还会把**任何** 401/403 的远程服务器自动标记为「需认证」，即便没写 `oauth` 块（用静态 `Authorization` 头的服务器豁免）。
- 首次在 `/mcp` 菜单里选 **Authenticate** 会打开浏览器走授权；回调由固定的本地端口接收（`mcp.oauth.callbackHost`/`callbackPort`，默认 `127.0.0.1:7777`）。
- token 持久化在 `~/.nova/mcp-auth/`，之后的会话静默刷新，无需再次登录。

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

## 18. 插件（Plugins）

插件把可复用的扩展打包成**「一个目录 + 一份 manifest」**，一条命令即可安装、启停、分发。**纯声明式 —— 不执行任何插件代码**，只是把目录里的扩展登记进来。格式**兼容 Claude Code 插件**。

Manifest 位于 `.nova-plugin/plugin.json`（优先）或 `.claude-plugin/plugin.json`（回退，二者不合并）。一个插件可同时贡献：

- **slash 命令、子 agent、skills、生命周期 hooks** —— 与你手写的 `.md` 扩展（[§14](#14-skills)/[§15](#15-自定义-slash-命令)）同源，只是随插件一起分发；命令 / agent 名以 `<插件名>:<名字>` 命名空间化。
- **MCP servers、LSP servers** —— 桥接进 [§16](#16-mcp-外部工具)/[§17](#17-lsp-代码智能) 的同一套机制。
- **`bin/` 可执行文件** —— 其目录被加进 `PATH`，供 `bash`（及沙箱）调用。

用 `nova plugin` 子命令从 shell 管理（它编辑 `~/.nova/nova.config.json` 的 `plugins` 块）：

| 命令 | 作用 |
|------|------|
| `nova plugin install <来源>` | 从本地路径、GitHub 仓库、git URL 或 marketplace 安装 |
| `nova plugin uninstall <name>` | 卸载一个插件 |
| `nova plugin list` | 列出已加载的插件及各自的贡献 |
| `nova plugin enable / disable <name>` | 启用 / 停用（停用不卸载） |
| `nova plugin marketplace add <来源>` | 注册一个 marketplace（插件目录），来源同 install |
| `nova plugin marketplace list / remove <name>` | 列出 / 移除已注册的 marketplace |

> 整个插件子系统**默认关闭**（`plugins.enabled` 默认 `false`）—— 即便装了插件，也要设 `plugins.enabled: true` 才会加载。REPL 内的 `/plugin` 只用于**查看**已加载插件及其贡献；安装 / 启停等改配置的操作走 `nova plugin` CLI。插件状态（`installed` / `marketplaces` / `enabled` / `disabled`）都落在 `nova.config.json` 的 `plugins` 块；已安装插件缓存在 `~/.nova/plugins/cache`，扫描目录默认含 `.nova/plugins`、`~/.nova/plugins`（及 `.claude/plugins` 兼容路径）。项目级插件遮蔽同名的用户级插件（首次出现者胜）。

---

## 19. 会话、检查点与数据落盘

### 恢复与切换

- `nova -c` / `nova --continue`：恢复最近一个 session。
- `nova --resume <id>`：按 id 恢复。
- REPL 内 `/resume [<id>]`：切到指定 session（不带参数则弹列表选，这也是浏览历史 session 的入口）。

### 回退（Rewind）

`/rewind [<n>]` 回到此前某条消息——**其后的对话历史与文件改动都会被丢弃**，相当于一个检查点回滚。

### 自动清理

启动时 Nova 会删掉**最近活动超过 `sessionCleanup.maxAgeDays`（默认 30 天）**的 session 目录（按文件最新 mtime 算「最后一次使用」，不是创建时间；当前活动 session 始终受保护）。设 `sessionCleanup.enabled: false` 可永久保留。

### 版本更新

- **更新检查 + 后台自动安装**：交互启动时以及运行中每小时，Nova 会比对 npm 上是否有新版。默认（`update.autoInstall: true`）发现新版就在后台静默跑 `update.command` 装好——但**当前进程已经把代码加载进内存了，装完不会热生效，下次启动 nova 才是新版**，卡片文案也据此提示。安装失败（比如全局安装权限不足）会退回普通的「运行 `nova upgrade`」提示，并按 `notifyIntervalHours` 退避后重试，不会每小时重装。设 `update.autoInstall: false` 回到只提醒不安装。
- **提醒限流**：为避免长时间会话被反复打扰，同一提醒最多每 `update.notifyIntervalHours`（默认 6h）弹一次（拉取版本本身不限流；一次成功的后台安装则总会提示一次）。上次提醒时间和最近一次自动安装记在 `~/.nova/update-check.json`；设 `update.enabled: false` 整个静音。
- **手动升级**：`nova upgrade` 跑 `update.command`（默认 `npm install -g @asathinkeroops/nova-code@latest --registry https://registry.npmjs.org`，可改成 pnpm/yarn/bun 全局安装）把自己升到最新版。默认命令显式指定 npmjs 官方源，与版本检测查询的 registry 一致——如果你的 npm 配置了未同步的镜像（`npm config get registry` 可查），裸命令会"成功"装回旧版。安装后 `nova upgrade` 会校验磁盘上的实际版本，装到旧版时会明确报错而不是宣称成功。`nova --version` 打印当前版本。

### 数据落在哪

| 内容 | 路径 |
|------|------|
| 全局配置 | `~/.nova/nova.config.json` |
| 历史 session | `~/.nova/sessions/{id}/` |
| transcript（hook 事件流） | `~/.nova/sessions/{id}/transcript.jsonl` |
| 可重放 message 历史 | `~/.nova/sessions/{id}/messages.jsonl` |
| 子 agent transcript/message | `~/.nova/sessions/{id}/subagents/` |
| session 日志 | `~/.nova/sessions/{id}/session.log` |
| 定时调度条目（cron/loop） | `~/.nova/sessions/{id}/cron/{id}.json` |
| 持久化 Task | 工作区内 `.tasks/{id}.json` |
| 自动记忆（agent 自维护） | `~/.nova/projects/<项目路径编码>/memory/`（`MEMORY.md` + 每条一文件；`memory.auto.dir` 可改回工作区内） |
| MCP OAuth token | `~/.nova/mcp-auth/` |
| 更新检查节流状态 | `~/.nova/update-check.json` |
| 跨会话 token 累计（状态行「累计」命中率） | `~/.nova/usage.json` |

> `--no-transcript` 让本次不写 transcript；`transcript.enabled: false` 全局关闭。

---

## 20. 配置文件完整参考

配置文件位于 `~/.nova/nova.config.json`，是一份 JSON。下面列出全部字段及默认值（来自 zod schema，**每个可配项都有默认值，缺省即用默认**）。

### 顶层与模型

| 字段 | 默认 | 说明 |
|------|------|------|
| `apiKey` | （无） | provider API key（首次向导会写入）。**环境变量 `NOVA_API_KEY` 优先于此项**：设了就用它，配置文件里的值作为兜底。想把 key 留在环境里、不落到明文配置文件时用这个 |
| `provider` | `"deepseek"` | 驱动 thinking 参数、错误翻译、重试策略的 **provider profile**：`deepseek`（effort 旋钮 + 错误翻译 + 状态码重试）/ `moonshot` / `other`（通用 Anthropic 兼容端点，用 `budget_tokens`、不翻译错误）。未知 id 回退到 `other` |
| `model` | `"pro"` | 当前**档位**：`models` 表中的 key（`lite`/`pro`/`max`），**永远不是裸模型 id** |
| `models` | `{}` | 命名的模型档位表，value 为**档位对象**，每档带自己的 `id`、`maxTokens`、`contextWindowSize`、`thinking`、`modalities`、`pricing`、可选 `description`。非空时**必须含 `lite`/`pro`/`max` 三档**（schema 强制）；首次向导按 provider 模板写入，schema 不再提供默认值 |
| `baseURL` | （无） | Anthropic 兼容端点 URL（provider 模板写入；缺省则用 SDK 默认端点） |
| `sessionDir` | （无→ `~/.nova/sessions`） | session 存放目录 |
| `language` | `"auto"` | **模型回复语言**（注入 system prompt），同时也是 TUI 界面语言的默认来源；`auto` 跟随系统 locale（`$LC_ALL`/`$LANG`/`$LANGUAGE`，macOS 还读 `AppleLocale`），否则填 BCP-47 标签如 `en`/`zh-CN`。加载时 `auto` 会被解析成具体标签 |
| `locale` | `"auto"` | **仅 TUI 静态文案**的语言覆盖（菜单/提示/状态行）；`auto` = 跟随 `language`。内置 zh-CN 与 EN，其它标签回落英文。两者可不同（中文界面 + 英文回复），见 [§5](#5-交互式界面tui) |
| `maxTokensContinuations` | `3` | 单次响应被该档 `maxTokens` 截断时，允许自动「续写」的连续次数（`0` = 老式硬停） |
| `maxTurns` | `100` | 单轮最大循环次数 |
| `toolConcurrency` | `3` | 单轮内工具并发上限（1 = 全串行） |

> **每档输出上限 / 上下文窗口是 per-tier 的**：写在 `models.<tier>.maxTokens`（schema 缺省 32768，DeepSeek 模板三档均写 384000）和 `models.<tier>.contextWindowSize`（缺省 1000000）里，不再是顶层字段。`models.<tier>.thinking` 让同一个模型 id 也能拉出 lite/pro/max 的能力梯度（见 [§7](#7-思考等级thinking)）；`models.<tier>.pricing` 提供 `/usage` 成本估算的每百万 token 单价（见 `pricing` 一节）。

### `permissions`

| 字段 | 默认 | 说明 |
|------|------|------|
| `defaultEffect` | `"ask"` | 无规则命中时的兜底（`allow`/`deny`/`ask`） |
| `rules` | `[]` | 规则数组（首个匹配生效），见 [§10](#10-权限与安全) |
| `deny` | `[]` | 裸工具名黑名单：启动时从注册表摘除，模型看不到也调不了（比 `rules` 的 `deny` 更硬），见 [§10](#10-权限与安全) |
| `additionalDirectories` | `[]` | 工作区之外、读工具可免询问触及的目录 |
| `autoMode.llmClassifier` | `true` | `auto` 模式下把规则判不定的命令交给 LLM 风险分类器；关掉则一律弹确认 |
| `autoMode.model` | （无→ 便宜档） | 分类器用的模型（裸 id 或档位名），独立于 `/model` |
| `autoMode.classifierTimeoutMs` | `8000` | 分类器超时；超时按「有风险」处理（弹确认，不静默执行） |

### `planMode`（plan 模式的进出）

| 字段 | 默认 | 说明 |
|------|------|------|
| `agentTools` | `true` | 注册 `enterPlanMode` / `exitPlanMode`，让模型自己切进只读 plan 模式、方案获批后再退出；关掉则 plan 模式只能手动进（<kbd>Shift+Tab</kbd> / `--permission-mode plan`），见 [§10](#10-权限与安全) |
| `approvalGate` | `true` | 一轮结束时若仍在 plan 模式，由 nova 自己弹确认框：同意就恢复进入前的权限档并立刻续跑实现。不依赖模型调 `exitPlanMode`；关掉则退出全靠模型自觉或你手动 <kbd>Shift+Tab</kbd> |

### `trust`（工作区信任）

| 字段 | 默认 | 说明 |
|------|------|------|
| `trust.enabled` | `true` | 启动时确认工作区可访问；`false` 恢复「启动即信任」，见 [§10](#10-权限与安全) |
| `trust.trustedRoots` | `[]` | 已信任的绝对路径（授权时自动追加，也可手工预置）；工作区位于任一根之下即可信 |

### 思考等级（thinking）

**没有顶层 `thinking` 配置项**——思考等级是 per-tier 的，写在 `models.<tier>.thinking`（`off`/`low`/`medium`/`high`/`max`；缺省回退 `max`）。`-t/--think`、`/effort` 是会话内覆盖，见 [§7](#7-思考等级thinking)。

### `pricing`（`/usage` 成本估算）

| 字段 | 默认 | 说明 |
|------|------|------|
| `pricing.enabled` | `true` | 开关 `/usage` 与状态行的成本估算 |

> 单价本身是 **per-tier** 的：写在 `models.<tier>.pricing`（`input`/`output`/`cacheRead`/`cacheWrite` 每百万 token，`currency` 选 `USD`→`$` 或 `CNY`→`¥`）。用当前档位自己的费率算钱；某档没写 `pricing` 就只显示 token、不显示金额。

### `compact`

| 字段 | 默认 | 说明 |
|------|------|------|
| `auto.enabled` | `true` | 上下文吃紧时自动压缩（追加 `<compacted>` 边界，见 [§12](#12-上下文管理与压缩)） |
| `auto.contextWindowPercent` | `0.9` | 触发阈值占上下文窗口的比例，按**整个请求**计（含 system / 工具 schema，与 `/context` 同口径） |
| `auto.thresholdTokens` / `maxSummaryTokens` | （内置常量） | 绝对阈值覆写（优先于比例）/ 摘要长度上限 |

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
| `predict.maxChars` | `300` | 预测占位最大字符数 |
| `todo.autoClearDelayMs` | `2500` | 一张 todo 清单全部完成后自动清空前的停留时长（`0` = 不自动清，交给模型自己调 `clearTodoList`） |
| `task.autoClearDelayMs` | `2500` | 同上，但针对落盘的 Task 计划——全部完成后连同 `.tasks/` 文件一起删（`0` 关闭） |
| `logging.level` | `"info"` | `trace`…`fatal` |
| `logging.pretty` | `true` | pretty 日志（`--no-pretty` 关） |

### 持久化

| 字段 | 默认 | 说明 |
|------|------|------|
| `transcript.enabled` | `true` | 写 transcript（`--no-transcript` 临时关） |
| `sessionCleanup.enabled` | `true` | 启动时清理旧 session |
| `sessionCleanup.maxAgeDays` | `30` | 旧 session 的天数阈值 |
| `update.enabled` | `true` | 检查 npm 新版，见 [§19](#19-会话检查点与数据落盘) |
| `update.autoInstall` | `true` | 发现新版就后台静默安装（下次启动生效）；`false` 则只提醒 |
| `update.notifyIntervalHours` | `6` | 同一更新提醒的最小间隔（同时用作失败安装的退避间隔） |
| `update.command` | `npm install -g @asathinkeroops/nova-code@latest --registry https://registry.npmjs.org` | `nova upgrade` 跑的安装器（可改 pnpm/yarn/bun；默认显式走 npmjs 官方源，避免镜像滞后装回旧版） |

### 扩展子系统

| 字段 | 默认 | 说明 |
|------|------|------|
| `memory.filenames` | `["NOVA.md","CLAUDE.md","AGENTS.md"]` | 记忆文件名优先级，见 [§13](#13-记忆memory) |
| `memory.userPaths` / `globalPath` | （无） | 覆盖用户层/全局记忆路径 |
| `memory.auto.*` | `enabled:true` | 自动记忆（agent 自维护）：默认 `~/.nova/projects/<项目编码>/memory/`（`dir` 未设，可设为工作区内路径覆盖）、`maxEntries`=100，见 [§13](#13-记忆memory) |
| `slash.enabled` | `true` | 自定义 slash 命令开关；`projectDirs`/`userPaths`/`extraDirs` 额外目录 |
| `skills.enabled` | `true` | Skills 开关；`indexBudgetFraction`=0.01、`maxDescriptionBytes`=1536、`maxResponseBytes`=16384、`maxFileBytes`=1048576、`disableShellExecution`=false；`maxIndexBytes` 可选（钉死索引预算，优先于比例）；及额外目录 |
| `subagent.enabled` | `true` | 子 agent 开关；`model`（按子 agent 名索引的档位表，见 [§8](#8-plan-模式与子-agent)）/`maxTurns`=100/`maxTokens`=32768 |
| `guide.*` | `enabled:true` | nova-code-guide 来源：`source`=`remote`（默认，克隆 `repoUrl`@`ref`→`cacheDir`，`refreshIntervalHours`=24）或 `local`（读 `localPath`/工作区），见 [§8](#8-plan-模式与子-agent) |
| `goal.*` | `enabled:true` | `/goal` 目标模式：`evalModel`（判定档位，模板设 `lite`）/`maxContinuations`=25/`maxEvalTurns`=15 |
| `loop.*` | `maxIterations`=100 | `/loop` 重复任务：`maxIterations` 安全上限、`minIntervalMs`=1000 拒绝过密间隔，见 [§6](#6-slash-命令大全) |
| `cron.*` | `enabled:true` | 定时调度工具：`maxSchedules`=20、`minIntervalMs`=1000、`maxIterations`=100（`enabled` 只管 agent 工具，`/loop` 不受影响），见 [§9](#9-内置工具一览) |
| `websearch.*` | 无 | `websearch` 工具的搜索商 key：`braveApiKey` / `tavilyApiKey` / `serperApiKey`，配一个即可（按此顺序自动选）；对应环境变量 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY` **优先于**配置文件里的同名 key（与 `apiKey` 规则一致） |
| `background.autoContinueOnComplete` | `true` | 后台命令跑完且 agent 空闲时，自动唤起一轮让它处理结果 |
| `queue.consumeInLoop` | `true` | 回合运行中新键入的普通 prompt 在 loop 边界即时折入（`/` 与 `!` 行仍排队） |
| `terminal.syncOutput` / `cursorFollow` | `true` / `true` | 同步输出（防闪烁）/ 光标跟随输入框（IME 定位） |
| `lsp.*` | `enabled:true` | LSP，见 [§17](#17-lsp-代码智能) |
| `mcp.*` | `enabled:true` | MCP；`servers`/`timeoutMs`=60000/`oauth.*`（回调 `127.0.0.1:7777`、`autoDetect:true`），见 [§16](#16-mcp-外部工具) |
| `sandbox.*` | `enabled:false` | 命令沙箱（**默认关**）；`filesystem.*` + `network.*`（默认不限网，可设 `allowedDomains`/`deniedDomains`），见 [§11](#11-命令沙箱) |
| `plugins.*` | `enabled:false` | 插件子系统（**默认关**）；`projectDirs`/`userDirs`/`disabled`/`installed`/`marketplaces`，见 [§18](#18-插件plugins) |
| `hooks.*` | `enabled:true` | 用户事件 shell 钩子，见下方 [`hooks`](#hooks用户事件-shell-钩子) |

> 临时覆盖：`-m/--model`、`-t/--think`、`--max-turns`、`--cwd`、`--no-transcript`、`--no-pretty` 只影响本次会话，不写回文件。

### `hooks`（用户事件 shell 钩子）

在生命周期事件上跑你自己的 shell 命令——无需改代码即可实现「写完文件自动 format / lint」「提交前注入上下文」等自动化。这些声明式 hook 由 CLI 桥接到内核的 `HookRegistry` 上，命令在与 `bash` 工具**相同的 OS 沙箱**里执行。

**工具/对话事件**（名字沿用 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 约定；`Stop` 见下方生命周期表）：

| 事件 | 触发时机 | 退出码语义 | stdout 语义 |
|------|----------|-----------|-------------|
| `PreToolUse` | 工具执行**前**，作为权限门的**第一步**（早于权限模式 / 规则） | **非 0 → 拒绝该次工具调用**，stderr 作为拒绝理由 | 忽略（用 JSON `permissionDecision` 表达 allow/ask,见下） |
| `PostToolUse` | 工具执行**后** | 非 0 → 把结果标记为错误 | 追加到回灌给模型的工具结果里 |
| `UserPromptSubmit` | 每轮**开始前** | **非 0 → 中止本轮**，stderr 作为理由 | 追加到用户输入作为上下文 |

**生命周期事件**（`matcher` 匹配 source/trigger；沿用 **exit 2 = 阻断** 约定，其它非 0 = 非阻断错误仅记日志）：

| 事件 | 触发时机 | `matcher` subject | 阻断语义 |
|------|----------|-------------------|----------|
| `SessionStart` | 会话启动 / `/resume` / `/clear` 后 | `startup` \| `resume` \| `clear` | advisory |
| `SessionEnd` | 退出 REPL 时（沙箱销毁前） | `exit` | advisory |
| `PreCompact` | 自动或 `/compact` 压缩**前** | `auto` \| `manual` | **exit 2 → 跳过本次压缩**（stderr 作理由） |
| `PostCompact` | 压缩**后** | `auto` \| `manual` | advisory |
| `Stop` | 每轮**结束后** | （无） | **exit 2 → 强制本轮继续**：stderr 作为下一轮 prompt 喂回模型 |

> `Stop` 强制继续带硬上限(默认 8 次)防死循环;hook 可读 payload 的 `stop_continuation`(0 起的已继续次数)自行收手。阻断自动压缩有上下文溢出风险,谨慎使用。

每条 hook 形如 `{ matcher?, command, timeout_ms? }`：

- `matcher`：正则。对工具事件匹配**工具名**，对生命周期事件匹配 **source/trigger**（上表第三列）。省略 = 全部匹配。无法编译的正则视为不匹配。
- `command`：经 `bash -lc` 执行的命令，**走与 `bash` 工具相同的 OS 沙箱**，工作目录即工作区根。
- `timeout_ms`：默认 `60000`，上限 `600000`。

命令通过 **stdin 上的单个 JSON 对象**拿到上下文（对齐 Claude Code 约定，用 `jq` 取字段）。所有事件都带公共字段 `hook_event_name`、`session_id`、`transcript_path`、`cwd`；其余按事件：

- 工具事件：`tool_name`、`tool_input`（原始对象）、`file_paths`（`write`/`edit` 受影响的绝对路径数组）、`tool_response` 与 `is_error`（仅 `PostToolUse`）、`prompt`（仅 `UserPromptSubmit`）。
- 生命周期事件：`source`（SessionStart）、`reason`（SessionEnd）；`trigger`、`before`、`after`、`archived_transcript_path`（*Compact）；`stop_continuation`（Stop）。

> 例如 PreToolUse 守卫取待执行命令：`cmd=$(jq -r '.tool_input.command')`。

**回话:退出码 或 stdout JSON。** 简单 hook 用退出码即可(上表语义)。需要更精细的控制时,把一个 **JSON 对象写到 stdout**——识别到合法 JSON 时其结构化决定**优先于**退出码,否则退回「退出码 + 原始 stdout」。支持字段:

| 字段 | 作用 |
|------|------|
| `decision: "block"` + `reason` | `PostToolUse` 标记结果为错误并把 `reason` 回灌;`UserPromptSubmit` 中止本轮;`PreCompact` 跳过压缩;`Stop` 强制继续(等价 exit 2) |
| `hookSpecificOutput.permissionDecision: "deny" \| "allow" \| "ask"` + `permissionDecisionReason` | **仅 `PreToolUse`**:`deny` 拒绝;`allow` **绕过权限门**(权限模式 + 规则,直接放行);`ask` **强制弹确认**(即便权限门本会自动放行)。多个 hook 时优先级 `deny` > `ask` > `allow` |
| `hookSpecificOutput.additionalContext` | `PostToolUse` / `UserPromptSubmit` 追加到回灌模型的文本(给出时**取代**原始 stdout) |

```jsonc
// PreToolUse 守卫:用 JSON 拒绝(可不依赖退出码)
// echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"命中危险命令"}}'
```

```jsonc
{
  "hooks": {
    "enabled": true,                       // 总开关（默认 true）
    "PostToolUse": [
      { "matcher": "write|edit", "command": "jq -r '.file_paths[]' | xargs -r prettier --write" },
      { "matcher": "write|edit", "command": "jq -r '.file_paths[]' | xargs -r eslint --fix" }
    ],
    "PreToolUse": [
      { "matcher": "bash", "command": "./scripts/guard.sh" }   // 读 stdin 的 .tool_input.command；退出码非 0 → 拒绝
    ],
    "UserPromptSubmit": [
      { "command": "git status --porcelain" }                  // stdout 注入为上下文
    ],
    "Stop": [
      { "command": "osascript -e 'display notification \"done\"'" }
    ],
    "SessionStart": [
      { "command": "echo \"started $(jq -r .session_id)\" >> ~/.nova/audit.log" }
    ],
    "SessionEnd": [
      { "command": "git stash list" }
    ],
    "PreCompact": [
      { "command": "cp \"$(jq -r .transcript_path)\" /tmp/ 2>/dev/null || true" }
    ],
    "PostCompact": [
      { "command": "jq -r '\"compacted \\(.before)→\\(.after) (\\(.trigger))\"'" }
    ]
  }
}
```

#### 多源累加（全局 + 项目 + local）

除了全局 `~/.nova/nova.config.json` 的 `hooks` 段，hook 还可以**随仓库**声明在工作区根的两个文件里（形状就是上面的 `hooks` 对象，去掉外层 key）：

| 文件 | 用途 | 是否提交 |
|------|------|----------|
| `.nova/hooks.json` | 项目级，团队共享 | ✅ 提交进仓库 |
| `.nova/hooks.local.json` | 个人本地覆盖 | ❌ 建议加入 `.gitignore` |

三源按 **全局 → 项目 → local** 顺序**累加**（不是覆盖）：每个事件的数组拼接起来，全部都会跑；`(matcher, command)` 完全相同的条目自动去重（第一个生效）。`enabled` 取所有源的**逻辑与**——任一源设 `false` 即关闭。

```jsonc
// <workspace>/.nova/hooks.json
{
  "PostToolUse": [
    { "matcher": "write|edit", "command": "jq -r '.file_paths[]' | xargs -r pnpm prettier --write" }
  ]
}
```

> ⚠️ **安全提示**：项目级 hook 会在你打开该仓库时**执行本地 shell 命令**（与拉取不可信仓库的供应链风险同理）。Nova 启动时会显式弹一张卡片列出已加载的项目 hook 文件；命令仍受 OS 沙箱**写入**约束，但读取/网络不受限。审阅来路不明仓库的 `.nova/hooks*.json` 后再运行。

---

## 21. 常见问题与排查

**Q：在管道 / CI 里能用吗？没有 TTY 会怎样？**
A：能。没有 TTY 时 Nova 不会报错，而是走 **headless** 模式：跑一轮（prompt 从参数、`-p` 或 stdin 取）、打印结果、退出。要机器可读输出用 `--output-format json|jsonl`；无人值守批准配 `--dangerously-skip-permissions`。全屏 REPL 才需要真正的终端。

**Q：启动时让我确认「是否信任这个文件夹」。**
A：这是工作区信任门（见 [§10](#10-权限与安全)）。选 Yes 会把该目录记进 `~/.nova/nova.config.json` 的 `trust.trustedRoots`，以后不再问；对 `~` 授予的信任只在本次会话有效。headless 场景弹不出这张卡片，未信任会直接失败——先交互式信任一次，或手工加进 `trust.trustedRoots`，或用 `--dangerously-skip-permissions`。

**Q：想要中文界面但英文回复（或反过来）。**
A：`language` 管模型回复语言，`locale` 只管 TUI 静态文案。要中文界面 + 英文回复就写 `{"locale": "zh-CN", "language": "en"}`；两者默认都是 `auto`（跟随系统 locale）。改完重启生效——回复语言写在 system prompt 里，会话中途改会击穿前缀缓存。

**Q：能读 PDF 吗？**
A：能。`read` 直接吃 `.pdf`（≤30MB），抽取的文本带行号、每页前有 `[Page N]` 标记，`offset`/`limit` 照常翻页。扫描件 / 纯图片 PDF 抽不出文本，工具会明说并建议改用 `ocrmypdf`/`tesseract` 之类先 OCR。

**Q：启动报 apiKey 未设置。**
A：跑一次首启向导填上，或手动编辑 `~/.nova/nova.config.json` 的 `apiKey`/`baseURL`/`model`；也可以只导出环境变量 `NOVA_API_KEY`（优先于配置文件里的 `apiKey`，`/doctor` 会标明当前 key 的来源）。

**Q：`websearch` 报缺 key。**
A：在 `~/.nova/nova.config.json` 的 `websearch` 下填 `braveApiKey` / `tavilyApiKey` / `serperApiKey` 任一项，或设置对应环境变量 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY`（按 brave → tavily → serper 顺序自动选用；同一家两处都配时**环境变量优先**，与 `apiKey` 同一条规则）。

**Q：每次写文件/跑命令都来问我，太烦。**
A：在审批框选 **Always allow this tool**（本 session 内不再问），或在 `permissions.rules` 里给具体命令/工具加 `allow` 规则（见 [§10](#10-权限与安全)）。

**Q：某条命令被沙箱拦了写入。**
A：把目标路径加进 `sandbox.filesystem.allowWrite`；若要写 `.git/hooks` 等 SDK 强制保护路径，只能 `sandbox.enabled: false` 关掉沙箱。

**Q：`lsp` 总说「未安装」。**
A：Nova 不装语言服务器。先把对应二进制装到 PATH（`typescript-language-server`/`pyright-langserver`/`gopls`/`rust-analyzer`），用 `/lsp` 确认状态。

**Q：感觉缓存没命中、变慢变贵。**
A：保持历史前缀稳定——靠 append-only 历史和 auto 压缩（追加 `<compacted>` 边界，不改写更早内容）各司其职。状态行可看每轮缓存命中量。

**Q：想回到几步之前、撤掉刚才的改动。**
A：`/rewind [<n>]` 回退到更早的消息（其后的历史与文件改动会被丢弃）。

**Q：怎么升级 Nova？**
A：`nova upgrade` 跑配置里的安装器升到最新版；交互启动时若有新版也会（限流地）提示。`nova --version` 看当前版本。想静音提醒设 `update.enabled: false`。

---

*本手册依据当前代码生成。如对内部架构、loop 契约或扩展点感兴趣，请进一步阅读仓库根的 `CLAUDE.md` 与 `README.md`。*
