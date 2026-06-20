# Nova 三大核心亮点

> 本文从技术实现角度提炼 Nova 最独特、最具创新性的三个核心能力。每一节都解释 **做了什么、为什么这么做、怎么做出来的**，让开发者理解 Nova 与其他 AI 编程工具的实质性差异。

**项目地址**：<https://github.com/asathinkeroops/nova-code>

![Nova 截图](../snapshots/screen.png)

---

## 亮点一：DeepSeek 一等公民 —— 全链路深度适配

Nova 不只是"兼容 DeepSeek"，而是**围绕 DeepSeek 的协议特性从消息格式、缓存策略、错误处理到计费面板做了全链路适配**。每层设计都吃透了 DeepSeek 的 wire protocol 脾性，让开发者开箱即用，无需翻阅文档手工调参。

### 1.1 思考模式自动映射

DeepSeek 的思考预算通过 `output_config.effort`（`high` / `max`）控制，与 Anthropic 的 `budget_tokens` 是两套体系。Nova 做的事：

- **模型 ID 自动检测**（`packages/core/src/model.ts` — `detectThinkingFormat`）：根据模型名判断是 `anthropic` 还是 `deepseek` 格式，自动选择对应的 wire format。
- **5 级预算 → 原生 effort 映射**：`off` / `low` / `medium` / `high` / `max` 五个粒度的用户选项，在不同模型上映射为不同的底层参数。对 DeepSeek 而言 `< 32k → high`，`≥ 32k → max`。
- **零摩擦切换**：用户只需 `/effort high` 或 `-t high`，完全不接触 `output_config`、`budget_tokens` 这类底层字段。

### 1.2 上下文缓存全自动命中

DeepSeek 的服务端上下文缓存依赖请求前缀的**字节稳定性**——前缀一旦变动，缓存即失效。Nova 为此做了一整套工程约束：

- **消息历史只追加（append-only）**：`appendMessage`（`packages/core/src/messages.ts`）始终返回新数组，绝不原地修改已有条目。这是全栈最硬的约束之一，见 CLAUDE.md 第三条循环契约。
- **持久化层前缀感知**：`persistMessages`（`packages/agent/src/persistence.ts`）在磁盘写入时采用快慢双路径——先对比当前 `messages.jsonl` 前缀与内存是否一致，一致则直接 `appendFile` 追加写入；不一致（仅发生在 compact / clear / shrink 后）才做原子 `rename(tmp, path)` 全量重写。前缀匹配意味着缓存命中，全量重写意味着缓存重建。
- **微压缩默认关闭**：在 DeepSeek 上，过于激进的上下文压缩会频繁打断前缀而导致缓存重建成本远超压缩收益。Nova 默认关闭 micro-compact，只在真正必要（如逼近 token 上限）时才做一次前缀重置。这是**刻意为之的性能决策**，而非功能缺失。

### 1.3 错误码翻译 + 智能重试

DeepSeek API 返回的状态码不是英文也没问题——Nova 帮你看懂并告诉你该怎么做：

- **7 种状态码中文翻译**（`packages/core/src/deepseek-errors.ts`）：400 / 401 / 402 / 422 / 429 / 500 / 503 每种都附带中文描述、原因分析和操作建议，并附 DeepSeek 官方文档链接。
- **瞬态错误自动重试**：429（速率限制）/ 500 / 503 触发最多 4 次指数字退避重试，UI 层通过 `onRetry` 回调感知重试进度。注意：这是 DeepSeek **专属**逻辑——其他模型不做内部重试，因为它们的错误语义不同。
- **非瞬态错误即时反馈**：401 告诉你 API Key 过期，402 提醒余额不足，422 指出参数问题——全部在 TUI 中高亮显示，不必退出 REPL 去读日志。

### 1.4 实时费用可视化

- **余额面板**：Nova 直调 DeepSeek 的 `/user/balance` 端点，在状态栏展示账户余额。这是目前极少有 AI coding agent 做的深度集成。
- **会话花费跟踪**：`/usage` 按 token 桶拆分明细——cache-read / cache-write / uncached / output 各花了多少钱，让缓存收益变得可见。

---

## 亮点二：操作系统级命令沙箱 —— 纵深防御，默认开启

所有子进程工具（`bash`、长时间运行命令）都在 **OS 原生沙箱**中执行，文件系统**写入被限制在工作区范围内**。这不是简单的路径白名单，而是内核级强制约束。

### 2.1 双层架构：沙箱 × 权限引擎

Nova 的安全模型是**纵深防御**（defense-in-depth），两层独立机制叠加：

```
模型请求 bash
    │
    ▼
权限引擎（HookRegistry → pre_tool_use）
    ├── 路径规范化（canonicalizePath，解符号链接）
    ├── allow / deny / ask 规则匹配
    └── 放行 → 进入下层
            │
            ▼
    OS 沙箱（Seatbelt / bubblewrap）
            ├── 内核级写入限制
            └── 命令输出标注违规信息
```

- **上层（权限引擎）**：可配置，用户可干预（`ask` 模式弹窗确认）。
- **下层（沙箱）**：不可绕过，即使权限引擎放行，沙箱仍然兜底。两个层的 `writeRoots` 共享同一套 `canonicalizePath` 解析后的根路径，保证边界一致。

### 2.2 平台原生实现

- **macOS**：使用 Seatbelt（`sandbox-exec`），Apple 内核级沙箱框架。
- **Linux**：使用 bubblewrap，Flatpak 使用的轻量沙箱。
- **底层**：基于 `@anthropic-ai/sandbox-runtime`（[github.com/anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)），每次命令执行即时创建 + 执行后立即销毁。

### 2.3 默认开启，零摩擦

这是最关键的体验设计——沙箱**默认开启且从不报错**：

- 在支持的平台（macOS / Linux）上自动激活。
- 在不支持的平台或缺少依赖时**静默降级**为 `bridge: undefined`——agent 正常执行，只是不做沙箱约束。Nova 记录原因但不中断流程。
- 用户不需要任何配置：无需写规则文件，无需学习 Seatbelt 语法，无需显式启用。从 `pnpm dev` 启动那一刻起，`bash` 就已经被沙箱保护。

### 2.4 开箱即用的预授权

纯粹的文件写入限制会破坏大量常用开发操作。Nova 预授权了一套精心挑选的路径白名单（`DEFAULT_SANDBOX_ALLOW_WRITE`）：

- **包管理器缓存**：`~/.npm` / `~/.pnpm` / `~/.cargo` / `~/.go` —— `npm install` 无需额外配置即可在沙箱内正常工作。
- **危险路径强制拒绝**：`.git/hooks` / `.vscode/` / `.ssh/` / dotfiles（`.bashrc` / `.zshrc` 等）——即使在工作区内，这些路径也被沙箱 SDK 强制拦截。

### 2.5 违规可见化

沙箱拦截不是静默的——`SandboxBridge.annotateOutput` 将违规信息追加到命令输出中，让模型能看到诸如 `sandbox blocked write to /etc/passwd` 的提示，从而理解失败原因并调整行为（例如写入正确的工作区路径）。

---

## 亮点三：Markdown 驱动的可扩展系统 —— 子代理、命令、技能、Hook 一体化

Nova 的扩展模型有一条统一原则：**放一个带 YAML frontmatter 的 `.md` 文件，它立刻变成运行时能力**。不需要改 TypeScript 源码，不需要重新编译，甚至不需要重启 REPL。项目级扩展可以提交到 Git，团队成员共享。

### 3.1 子代理（Sub-agents）

子代理是具有**独立上下文**的并发执行单元——看不到父会话历史，只返回最终报告。

**定义方式的极简性**：在 `.nova/agents/`（或 `.claude/agents/`）下放一个 `.md` 文件：

```markdown
---
name: reviewer
description: 只读代码审查，输出 file:line 格式的问题
tools: [read, grep, glob, lsp]
readOnly: true
model: deepseek-chat
maxTurns: 20
---
你是只读代码审查子代理。逐文件审查 diff，按 file:line 格式报告问题……
```

- **YAML frontmatter** 声明元数据：名称、描述、可用工具集、是否只读、指定模型、最大轮次 / token。
- **正文** 是子代理的系统提示——你想让它做什么，直接用自然语言写进去。
- 三种**内置类型**（`explore` / `plan` / `general-purpose`）始终可用，用户自定义类型通过 `/agents` 可见、`/agent reviewer <任务>` 可调、模型的 `createSubAgent` 可选。
- 同轮可**并发启动多个子代理**，每种类型有独立的并发上限。
- **分层覆盖**：项目级（`.nova/agents/`）优先于用户级（`~/.nova/agents/`），内置类型始终可用但可被同名覆盖。

### 3.2 自定义斜杠命令

同一套 `.md` + frontmatter 模式用于定义命令：

- 文件放在 `.nova/commands/`（或 `.claude/commands/`）
- Frontmatter：`name` / `description` / `args`
- 正文作为 prompt 模板发送给模型，`$ARGUMENTS` 接收用户输入

```markdown
---
name: review
description: 审查当前分支的改动
args: "[base-branch: main]"
---
请审查当前分支相对于 $ARGUMENTS[0] 的差异。
```

### 3.3 技能（Skills）

`SKILL.md` 是另一种按需加载的 Markdown 知识包：

- **静态注入**：`SKILL.md` 的 description / index 在启动时注入系统提示，让模型知道有哪些可用技能。
- **按需加载**：当模型认为某个技能适用时，调用 `loadSkill` 工具加载完整内容。
- **项目级可提交**：项目中的 `skills/` 目录可以包含多个 `SKILL.md`，团队成员共享。

### 3.4 生命周期 Hook（Claude Code 兼容）

Hook 是 Nova 事件系统的另一面——JSON 定义而非 Markdown，但同样不需要改代码：

- **8 种事件**：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` / `SessionEnd` / `PreCompact` / `PostCompact`
- **阻塞语义**：`PreToolUse` 退出码 ≠ 0 则拒绝工具执行；`PostToolUse` 的 stdout 会反馈给模型；`PreCompact` 退出码 = 2 则跳过压缩。
- **stdin JSON 协议**：每个 hook 被调用时，Nova 通过 stdin 传入单行 JSON（`jq` 友好），包含当前上下文、工具名、参数等信息。Shell 脚本通过 stdout 返回 JSON 表达决策。
- **三层合并**：
  1. 全局配置（`settings.hooks`）
  2. 项目级 `.nova/hooks.json`（可提交到 Git）
  3. 本地 `.nova/hooks.local.json`（仅自己可见）
  - 三层按事件类型合并去重，项目级环境可配置本地执行的选项。
- **典型场景**：`PostToolUse` 自动格式化写入的文件，`Stop` 发送桌面通知，`PreCompact` 在压缩前清理缓存。

### 3.5 MCP 协议桥接

虽然不是 Markdown 定义的，但 MCP（Model Context Protocol）延续了同一哲学——外部能力进入 Nova 的入口同样是声明式 + 零代码：

- 配置 MCP 服务器（stdio / HTTP / SSE），它们的工具自动以 `mcp__<server>__<tool>` 命名空间注册进工具表。
- 走和内置工具**完全相同的权限门**——MCP 工具不在安全边界上获得任何特权。

---

## 架构基石：支撑三大亮点的技术底色

这三大亮点不是孤立的 feature bullet，而是建立在一套**架构约束**之上，这些约束本身也是 Nova 的核心竞争力。

### 单一扩展点

`@nova/core` 的 `agentLoop` 有且只有一个 `HookRegistry`。权限门控、上下文压缩、转录写入、UI 更新、工具拦截——全部以 hook 形式接入。阻塞型 hook（`pre_*`）可返回决策让循环服从（先返回者胜出）；咨询型 hook（`post_*`）尽最大努力执行，出错不影响主流程。

> 这意味着：想加一个新能力？写一个 hook，挂上去。不需要改动循环的源代码。

下图展示了 `agentLoop` 的完整生命周期与 hook 扩展机制——每个生命周期点触发具名事件流入 `HookRegistry`，再分发给订阅者（◆ 阻塞型可改写 / 否决，○ 通知型只观察）：

![Nova agent loop 与 hook 机制](./agent-loop.svg)

### 严格的单向依赖

10 个包，依赖方向不可逆：

```
runtime, core, observability, lsp  ──► 零 @nova/* 源依赖（叶子层）
safety                             ──► runtime
context                            ──► core + runtime
tools                              ──► core + runtime + lsp
sandbox, external                  ──► core（仅类型依赖）
agent                              ──► core + runtime + context + observability
subagent                           ──► agent + context + core + observability + runtime
cli                                ──► 以上全部
```

`core` 从不导入任何模型 SDK、工具实现或 UI 组件——它是一套纯粹的、可复用的"无策略 Agent 循环"。

### zod 边界

所有跨越包边界、从外部进入类型系统的数据都经过 zod schema 校验：

- 工具输入校验失败 → 人话错误信息（`command is required (expected string)`），而非原始 zod issue。
- 配置文件、MCP 响应、hook 输入输出——schema 先行，类型从 schema 推导。

---

## 总结

| 亮点 | 一句话 | 开发者的实际收益 |
|---|---|---|
| **DeepSeek 一等公民** | 消息格式、缓存策略、错误处理、费用面板做到 DeepSeek 协议级原生适配 | 省钱（缓存命中）、省心（无需调参）、出错即知（中文诊断） |
| **OS 级沙箱** | 内核级写入限制，默认开启，静默降级 | 零配置安全，`npm install` 可跑，`/etc/passwd` 不能写 |
| **Markdown 可扩展** | 子代理 / 命令 / 技能全部通过 `.md` 文件定义，提交即生效 | 团队无需改代码即可定制 agent 行为，扩展能力随仓库共享 |

这三个亮点分别对应 **省钱**、**安全**、**灵活**——正是开发者选择一个终端 AI 编程工具时最关心的三个维度。
