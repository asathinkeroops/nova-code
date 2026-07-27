# Nova 功能现状与日常 Coding Agent 缺口分析

> 目标：评估把 nova 作为**日常 coding agent** 长期使用时，当前具备哪些能力、还缺哪些关键功能。
> 结论：内核已相当完整（loop / hooks / 权限 / compaction / sandbox / LSP / MCP / subagent / skills / rewind 均已具备），缺口主要集中在"日常体感"层面。

## 一、已具备的能力

对照下表避免重复造轮子。

### 工具（`packages/tools/src/builtin`）

| 工具 | 说明 |
| --- | --- |
| `read` / `write` / `edit` | 带行号读取、写入、精确字符串替换 |
| `bash` | 沙箱内执行命令（60s 上限） |
| `grep` / `glob` | 内容 / 文件名检索 |
| `webfetch` / `websearch` | 网页抓取与搜索 |
| `notebook-edit` | Jupyter notebook 编辑 |
| `lsp` | hover / 诊断 / 符号 / 定义 |
| `ask-user` | 向用户提问 |
| `skills` / `load-skill` | 技能加载 |
| `task` / `todo` | 任务与待办跟踪 |
| `long-running run` | 长时后台进程 |

### 斜杠命令（`apps/cli/src/commands`）

`/init` `/plan` `/effort` `/compact` `/lsp` `/mcp` `/agent` `/agents` `/skills` `/resume` `/rewind` `/predict` `/commands` `/clear` `/help`

- `/commands` 支持 **user / project 级 markdown 自定义命令**。

### 会话与上下文

- 会话恢复：`-c/--continue`、`--resume <id>`、`--list-sessions`
- `/rewind`：基于 write-ahead 文件快照的检查点回滚（`apps/cli/src/snapshots.ts`）
- auto-compact + `/compact` 手动压缩
- memory：NOVA.md / CLAUDE.md / AGENTS.md 三级，按目录优先级
- prefix cache

### 底座

- 权限模式 + 权限门控（hooks 实现）
- in-code `HookRegistry`（`packages/core/src/loop.ts` 唯一扩展点）
- subagent（`packages/subagent`）
- OS 级 sandbox（Seatbelt / bubblewrap，`packages/sandbox`）
- observability
- 模型：Anthropic SDK 客户端 + `baseURL` 覆盖，thinking 格式支持 `anthropic` | `deepseek`

## 二、关键缺口（按对日常使用的影响排序）

### 1. 多模态 / 图片输入 —— 影响最大

`read.ts` 完全没有 image / base64 / media_type 处理。日常 coding 高频需要贴报错截图、设计稿、UI bug 截图，目前无法做到。

- **取舍**：实现成本中等（read 识别图片转 base64 块 + 终端粘贴检测），但强依赖底层模型的视觉能力。DeepSeek 主力模型当前不支持视觉，与"deeply tuned for DeepSeek"定位冲突。
- **建议**：做成 capability 探测——模型支持视觉才开放，否则给清晰报错。

### 2. 非交互 / headless 模式 —— 影响大

`apps/cli/src/index.ts:34` 明确拒绝非 TTY 使用。无法 `nova -p "..." | ...`、无法进 CI、无法被脚本 / git hook 调用。日常常用于一次性任务（生成 commit message、批量改文件、pre-commit 检查）。

- **取舍**：复用现有 loop，新增非交互渲染路径（结构化 / 纯文本输出 + 退出码），**不碰内核**，性价比最高。
- **建议**：优先实现。

### 3. Git / PR 工作流 —— 影响大

无专用 git 工具，也无 `/commit`、`/review`、diff 审查类命令，全靠模型自己敲 bash。日常 coding 约一半时间在 git 上。

- **取舍**：无需做 git 工具（bash 已够），但值得加少量高频斜杠命令：`/commit`（diff 摘要 + 生成信息）、`/review`（审当前 diff）。纯 prompt 层封装，低成本高频收益。

### 4. 用户可配置的事件 hooks（shell 自动化）—— 影响中 ✅ 已实现

`HookRegistry` 是**代码内**扩展点；settings 无 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 这类"事件上跑 shell 命令"的声明式配置。无法配置"写完文件自动 format / lint"。

- **取舍**：在 `packages/runtime/src/config.ts` 加 zod schema，在 `apps/cli/src/hooks.ts` 把用户 hooks 桥接到现有 `HookRegistry`。内核不动，纯外围。
- **建议**：实现。
- **已落地**：`settings.hooks` 支持 8 个事件——工具/对话事件 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop`，以及生命周期事件 `SessionStart` / `SessionEnd` / `PreCompact` / `PostCompact`；每条 `{ matcher?, command, timeout_ms? }`。桥接在 `apps/cli/src/user-hooks.ts`（`UserHooks` 类：`register()` 接 3 个 loop 事件，`fire()`/`firePreCompact()`/`runStop()` 由 CLI 在 REPL 启停 / session 切换 / 压缩点直接触发生命周期与 Stop 事件）。命令走 `bash` 工具同款沙箱，上下文经 **stdin 上的单个 JSON 对象**传入(对齐 CC 约定:公共字段 `hook_event_name`/`session_id`/`transcript_path`/`cwd` + 事件特定字段,用 `jq` 取)。`PreToolUse` 非 0 退出拒绝工具、`PostToolUse` 的 stdout 回灌给模型、`UserPromptSubmit` 非 0 中止本轮。**阻断语义**(对齐 CC 的 exit 2 约定):`PreCompact` exit 2 跳过本次压缩(auto/manual 两路);`Stop` exit 2 强制本轮继续(stderr 作为下一轮 prompt,带 payload `stop_continuation` 计数 + 硬上限 8);其余生命周期事件 advisory。**stdout JSON 控制**(`parseHookOutput`,可选,优先于退出码):`decision:"block"`+`reason`、`hookSpecificOutput.permissionDecision:"deny"/"allow"/"ask"`(仅 PreToolUse)、`additionalContext`(回灌文本);非法 JSON 自动回退到退出码语义。**PreToolUse 全量对齐**:不走 loop 钩子,而是由 CLI 权限门 `checkPermission` 在最前一步调 `userHooks.evaluatePreToolUse()`——`deny` 拒绝、`allow` 绕过权限模式+规则、`ask` 复用 `askWithSignal` 强制确认;**无需改 `@nova/core`**(决定类型仍只表达 deny,allow/ask 在权限门内解析为 grant 或交互),subagent 工具因委托同一 `checkPermission` 一并生效。**项目级累加**:除全局配置外,hook 还可声明在工作区 `.nova/hooks.json`(随仓库提交)与 `.nova/hooks.local.json`(本地),三源按 全局→项目→local 累加并按 `(matcher, command)` 去重(`loadProjectHooks` / `mergeHooks`),启动时弹卡片提示已加载的项目 hook 文件。用法见 guide [§19 `hooks`](guide.md#hooks用户事件-shell-钩子)。

### 5. `@` 文件引用 / 输入补全 —— 影响中

REPL 无 `@path` 提及与文件名自动补全。日常频繁"把这个文件给你看"需手敲完整路径或让模型自行 read。

- **取舍**：纯 CLI 输入层功能，不碰 loop。中等收益。

### 6. 多 provider / 会话内换模型 —— 影响中

仅一个 Anthropic-SDK 客户端（`createAnthropicModel` + `baseURL` 覆盖）。换 provider 只能改 baseURL，无 OpenAI / Gemini 原生适配，无会话内 `/model` 切换或失败 fallback。

- **取舍**：与"专注 DeepSeek"定位相关，未必该做全多 provider。但会话内 `/model` 快速切换（同 provider 不同模型，如 reasoner ↔ chat）成本低、日常有用。

### 7. 自动更新 / 版本检查 —— 影响小

无 auto-update / 版本提示，长期使用易跑在旧版本。低优先。

## 三、建议优先级（ROI 排序）

1. **非交互模式** —— 解锁脚本 / CI / git hook 调用，不动内核，解锁场景最多
2. **`/commit` + `/review`** —— 覆盖 git 高频场景，纯 prompt 封装
3. ~~**用户可配置 hooks** —— format / lint 自动化~~ ✅ 已实现
4. **`@` 文件引用补全**
5. **多模态** —— 需等模型支持，且需先对齐 DeepSeek 定位
