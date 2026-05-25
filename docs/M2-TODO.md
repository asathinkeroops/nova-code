# M2 · 第 2 个月 — 每天能用

> 来源：`agent-harness-loop-architecture.html` · Roadmap M2（Week 5 → Week 8）
> 阶段目标：**Context + Safety + 工具齐备**
> 里程碑：Week 8 · **Dogfood Start** — 团队全部切到自家 harness 干活，每天产 transcript
> 验收：团队全员 dogfood — 一天真实 coding 工作能用，记得偏好、上下文不爆、token 成本可见

---

## 一、本期范围速览

| 周次 | 面 | 模块 | 交付物 |
|------|----|------|--------|
| W5 | C · context | `ctx/memory` | 记忆文件三层加载注入 system prompt（NOVA.md > CLAUDE.md > AGENTS.md）|
| W5 | C · context | `ctx/cache` | cache_control 三点断点 + 命中率统计 |
| W6 | C · context | `ctx/compact` | 自动摘要 + `/compact` 手动入口 |
| W6 | B · tools | `builtin v1` | edit / glob / grep / webfetch / websearch |
| W7 | B · tools | `tools/invariants` | read-before-edit · mtime check · 路径白名单 |
| W7 | ! · safety | `safe/hooks` | 4 个核心 hook 事件（Pre/PostToolUse · UserPromptSubmit · Stop）|
| W8 | G · external | `ext/slash` | `.commands/*.md` 解析 + 注册为内部命令 |
| W8 | H · obs | `obs/cost` + metrics 基础 | token 计费 · 缓存命中 · 工具成功率 · 预算阈值告警 |

> 涉及包：`packages/context`、`packages/tools`、`packages/safety`、`packages/external`、`packages/observability`

---

## 二、Week 5 — 上下文管理基础（C 面）

### 2.1 `ctx/memory` · 记忆文件三层加载

**目标**：在 LLM 收到 messages 之前，把记忆文件内容拼进 system prompt。

**文件名优先级**：`NOVA.md` > `CLAUDE.md` > `AGENTS.md`
- 同一目录下若同时存在多个，**只取优先级最高的那个**（不合并）
- 这样既兼容 Claude Code 生态（CLAUDE.md），又兼容通用 agent 约定（AGENTS.md），同时给 nova 自有的 NOVA.md 留出最高优先级覆盖口

- [x] 在 `packages/context/src/memory.ts` 实现三层加载
  - [x] **project** 层：从 cwd 向上递归查找记忆文件，直到仓库根（含 `.git`）
    - 每一级目录按 `NOVA.md` → `CLAUDE.md` → `AGENTS.md` 顺序探测，命中即停
  - [x] **user** 层：`~/.nova/NOVA.md` → `~/.claude/CLAUDE.md` → `~/.config/agents/AGENTS.md`（按优先级取第一个存在的）
  - [x] **global** 层：内置默认（可由 settings.json 覆盖路径）
- [x] 合并顺序：global → user → project（后者拼接在后，便于覆盖）
- [x] 暴露 `loadMemory(cwd): Promise<MemoryBundle>` → `{ system: string, sources: Array<{ layer, path, filename }> }`
  - `sources` 必须记录每层实际命中的文件名，便于排查"为什么 CLAUDE.md 没被读"这种问题
- [x] 在 `apps/cli/src/index.ts` 启动阶段加载、`buildSystemPrompt` 中注入到 system prompt（loop 本身保持模型无关，注入由调用方负责）
- [x] settings.json 暴露 `memory.filenames` 数组，允许用户覆盖默认优先级或新增文件名（同时支持 `memory.userPaths` / `memory.globalPath`）
- [x] 单元测试场景
  - [x] 三层都存在 / 缺失某层
  - [x] 嵌套子目录向上查找
  - [x] 同目录同时有 NOVA.md + CLAUDE.md → 只读 NOVA.md
  - [x] 同目录同时有 CLAUDE.md + AGENTS.md → 只读 CLAUDE.md
  - [x] 仅 AGENTS.md 存在 → 读 AGENTS.md

### 2.2 `ctx/cache` · Prompt Cache 打点

**目标**：在 system / tools / messages 三处插入 `cache_control: { type: "ephemeral" }`，并统计命中率。

- [ ] 在 `packages/context/src/cache.ts` 实现 cache breakpoint 注入
  - [ ] system prompt 末尾打 1 个断点（最大块）
  - [ ] tools 数组末尾打 1 个断点
  - [ ] messages[] 中按"上一轮 assistant 末尾"打 1 个断点（最多 4 个全局上限）
- [ ] 校验 token 阈值：Sonnet/Opus ≥ 1024 token；Haiku ≥ 2048 token（不足则跳过）
- [ ] 从 `response.usage` 读取 `cache_creation_input_tokens` / `cache_read_input_tokens`
- [ ] 写入 `obs/metrics`：`cache_hit_rate`、`cache_tokens_read`、`cache_tokens_created`
- [ ] **硬指标**：缓存命中率 ≥ 70%（写在 M2 验收条件里）
- [ ] 与 `obs/cost`（W8）联动：缓存读取按 0.1× 单价计费

---

## 三、Week 6 — 自动压缩 + 工具齐备

### 3.1 `ctx/compact` · micro_compact + auto_compact 两层压缩

**目标**：参考 `learn-claude-code/agents/s06_context_compact.py`，把"清理上下文"拆成两层策略，让 agent 可以无限长会话；并提供 `/compact` 手动入口。

> **设计原则（来自 s06 参考实现）**："The agent can forget strategically and keep working forever."
> - **Layer 1 · micro_compact**（静默，每次 LLM 调用前自动跑）—— 把超过 N 轮的旧 `tool_result` 内容替换为 `[Previous: used <tool>]` 占位符。读类工具（默认 `read`）保留输出作为参考材料，避免强制 agent 重新读文件。
> - **Layer 2 · auto_compact**（token 阈值触发）—— 落盘完整 transcript 快照，调 LLM 摘要后用单条 user message 替换全部历史。
> - **Layer 3 · /compact**（手动）—— 用户 / 模型主动触发 auto_compact，支持 `focus` 参数。

实现位置：`packages/context/src/compact.ts`（纯函数；loop 集成走 `compactor` hook，见 3.1.4）。

#### 3.1.1 Layer 1 · `microCompact`
- [x] 纯函数 `microCompact(messages, opts): { messages, replaced }`
  - [x] 扫描所有 `tool_result` block；保留最近 `keepRecent`（默认 3）个不动
  - [x] 老的 tool_result：若 content 是 string 且长度 > `minContentChars`（默认 100），替换为 `[Previous: used <toolName>]`
  - [x] tool 名通过历史 assistant 消息里的 `tool_use.id` 反查
  - [x] `preserveTools`（默认 `["read"]`）里的工具永不压缩 —— 读类输出是后续轮次的参考材料
  - [x] 不修改原数组，返回浅拷贝（替换次数为 0 时直接返回入参引用）
- [x] settings 字段：`compact.micro.{ enabled, keepRecent, minContentChars, preserveTools }`
- [x] 单测：≤ keepRecent 不动 / 老条目替换 / preserveTools 命中跳过 / 内容过短跳过

#### 3.1.2 Layer 2 · `autoCompact`
- [x] `estimateTokens(messages)` 粗估（与参考保持 ~4 chars/token）
- [x] `shouldAutoCompact(messages, thresholds)` —— 支持两种阈值
  - [x] 硬阈值 `thresholdTokens`（手动覆盖，无默认；不传则必须传 `contextWindowTokens`）
  - [x] 或：`contextWindowTokens × percent`（默认 50%）
- [x] `autoCompact(messages, { model, saveTranscript?, focus?, ... })`
  - [x] 调 `saveTranscript` 回调落盘 pre-compact 快照（CLI 后续传入：写到 `session.dir/snapshots/{ts}.jsonl`）
  - [x] 把 `JSON.stringify(messages)` 整段作为待摘要文本发给 LLM（上游 `shouldAutoCompact` 已保证规模可控，无需再截断）
  - [x] 摘要 system 提示固定（"输出 1) 已完成 2) 当前状态 3) 关键决策与开放问题"），`maxSummaryTokens` 默认 2000
  - [x] 返回：单条 user message → `[Conversation compacted [compacted]. Pre-compact transcript: <path>]\n\n<summary>`
  - [x] 透传 LLM `usage`（供 metrics / cost 累计）
- [x] settings 字段：`compact.auto.{ enabled, thresholdTokens, maxSummaryTokens, contextWindowPercent }`
- [x] 单测：摘要替换为单条 user / 透传 transcriptPath / focus 进入 prompt / 阈值判定

#### 3.1.3 Layer 3 · `/compact` 手动入口
- [x] CLI 注册 `/compact [focus...]` 临时入口（W8 上 ext/slash 后改成走通用 registry）
- [x] 接受可选 `focus` 文本作为摘要侧重点
- [x] 与 Layer 2 共用 `autoCompact()`

#### 3.1.4 集成到 agent loop
- [x] 在 `agentLoop` 新增可选 hook `compactor?: (messages) => Promise<MessageParam[]>`，每次 `model.call` 之前调用
- [x] CLI 配置 `compactor` 内部串联 `microCompact` → `shouldAutoCompact` → `autoCompact`
- [ ] 触发 `PreCompact` hook（W7 hooks 上线后接通；先留接口）
- [ ] 暴露 metric：`micro_compact_replacements_total`、`auto_compact_triggered_total`、`auto_compact_tokens_before/after`

#### 3.1.5 验收
- [x] 构造长会话（连续 N 轮 tool_use），确认 micro_compact 把老 tool_result 缩成占位符且后续对话继续
- [x] 构造超阈值消息，确认 auto_compact 触发后 estimateTokens 显著下降、对话能继续
- [x] `/compact` 在 REPL 中跑通；`focus` 文本进入摘要 prompt

### 3.2 `builtin v1` · 工具补齐

**目标**：在 M1 已有的 `bash / read / write` 之上补齐其余基础工具。

> 当前 `packages/tools/src/builtin/` 已有 edit / glob / grep / webfetch / websearch / notebook-edit 文件 — 需逐个核实是否已实现，未完成的补齐。

- [x] **edit.ts**：精确字符串替换（old_string → new_string），要求 old_string 唯一；支持 `replace_all`
- [x] **glob.ts**：基于 `fast-glob`；返回相对路径列表；尊重 `.gitignore`
- [x] **grep.ts**：spawn `rg`（ripgrep）；支持 pattern / path / glob / `-A`/`-B` 上下文行
- [x] **webfetch.ts**：fetch HTML → 转 markdown（`turndown` 或类似）；30 秒超时；尊重 robots
- [x] **websearch.ts**：接入外部搜索 API（先用一个，可配置）；返回 title + url + snippet
- [x] 全部工具的 description 写明"何时该用 / 何时不该用"（参考架构文档"③ 工具的标准"）
- [x] 在 `tools.test.ts` 里加 happy path + 错误路径用例

---

## 四、Week 7 — 工具不变量 + Hook 事件

### 4.1 `tools/invariants` · 工具内部安全

**目标**：在 dispatcher 调用工具前后强制保持几条铁律。

- [x] 在 `packages/tools/src/invariants.ts` 实现：
  - [x] **read-before-edit**：edit/write 调用前必须有同 session 的 read 记录（按绝对路径）
  - [x] **mtime check**：read 时记录 mtime；edit 时若文件已被外部修改则报错并要求重新 read
- [x] 在 `dispatcher.ts` 中将 invariants 串入调用链：`dispatch → safety → invariants → tool`
- [x] 给违规返回结构化错误（模型可读，告诉它"先 read 再 edit"）
- [x] 单测覆盖两类违规场景（read-before-edit / mtime drift）

### 4.2 `safe/hooks` · 4 个核心 hook 事件

**目标**：把 4 个最关键的 hook 事件先上线，settings.json 可配置。

> 全部 8 个事件留 M4；M2 先上这 4 个最常用的。

- [ ] 在 `packages/safety/src/hooks.ts` 实现 hook dispatcher
- [ ] **PreToolUse**：工具执行前触发；hook 可以 `block`/`approve`/`pass`
- [ ] **PostToolUse**：工具执行后触发；可读 tool 结果（只读，不可改）
- [ ] **UserPromptSubmit**：用户提交 prompt 时触发；hook 可改写或拦截
- [ ] **Stop**：loop 正常结束时触发
- [ ] hook 配置 schema（zod）写在 `packages/runtime/src/config.ts`
- [ ] hook 执行环境：`execa` spawn 子进程，超时 30s，stdout/stderr 走结构化日志
- [ ] 测试：写一个简单的"日志型" hook，确认事件触发顺序与数据形状

---

## 五、Week 8 — Slash 命令 + 观测基础

### 5.1 `ext/slash` · 自定义 slash 命令

**目标**：扫描 `.commands/*.md` 注册为内部 slash 命令，运行时把 markdown 模板插入 messages。

- [x] 在 `packages/external/src/slash.ts` 实现解析（front-matter + `{{arg|default}}` 占位）
- [x] 扫描位置（先发现胜，nova 生态优先）：
  - project: `{cwd}/.nova/commands/*.md` → `{cwd}/.claude/commands/*.md` → `{cwd}/.commands/*.md`
  - user: `~/.nova/commands/*.md` → `~/.claude/commands/*.md`
- [x] markdown front-matter 解析（描述、`args` schema）
- [x] `SlashRegistry`：内置命令（`/help` `/model` `/compact` …）与文件命令共用；同名时 **builtin 胜**，被遮蔽项记到 `source.shadowedBy`
- [x] REPL 输入 `/name args` 走 registry 分发；文件命令返回 `{ kind: "prompt", text }`，运行时塞进下一轮用户消息
- [x] `/commands` 列出所有命令（`[builtin]` / `[user]` / `[project]` 区分），`/commands reload` 重扫文件层
- [x] `settings.slash.{ enabled, projectDirs, userPaths, extraDirs }` 全开可配
- [x] 单测：解析 / 占位符 / 优先级 / 注册冲突

### 5.2 `obs/cost` + metrics 基础

**目标**：从 `usage` 计费，按会话/任务汇总；超过预算阈值告警。

- [ ] 在 `packages/observability/src/cost.ts` 实现：
  - [ ] 模型单价表（input / output / cache_read / cache_create 四档）
  - [ ] 从每次 `messages.create` 响应的 `usage` 累计
  - [ ] 按 session_id 维度聚合 → 写入 session 目录的 `cost.json`
- [ ] **预算阈值告警**：settings.json 配 `dailyBudgetUsd` / `sessionBudgetUsd`
  - [ ] 软阈值：日志 warn
  - [ ] 硬阈值：阻断下一轮 LLM call，提示用户
- [ ] 在 `packages/observability/src/metrics.ts` 暴露基础指标
  - [ ] `loop_iterations_total`
  - [ ] `tool_calls_total{tool, status}`
  - [ ] `tool_success_rate`
  - [ ] `cache_hit_rate`（与 ctx/cache 联动）
  - [ ] `cost_usd_total{session}`
- [ ] 输出格式：JSON 写入 transcript；OTel/Prometheus 留 M3
- [ ] 测试：跑一个固定脚本，确认 `cost.json` 数据正确

---

## 六、跨项要求（贯穿 W5–W8）

- [ ] **依赖方向遵守**（CI 用 dependency-cruiser 强制）
  - context → core + runtime
  - safety → runtime（保持瘦身）
  - external → core + tools + runtime
  - observability → runtime（只通过事件订阅介入，不反向 import）
- [ ] **TypeScript strict 全开**；新增公开 API 必须有 zod schema
- [ ] **Vitest 覆盖率**：每个新模块单测覆盖率 ≥ 70%
- [ ] **transcript 兼容**：所有新事件（hook 触发、compact、cost、cache 命中）落到 JSONL
- [ ] **settings.json 字段更新**：每加一个可配置项同步更新 `packages/runtime/src/config.ts` 的 schema 和示例文档

---

## 七、M2 验收清单

> Week 8 末统一过一次

- [ ] CLI 真实 coding 任务 ≥ 1 天，团队 ≥ 2 人使用
- [ ] 记忆文件偏好确实生效（NOVA.md / CLAUDE.md / AGENTS.md 至少 1 个生效；含一个反向测试 case）
- [ ] 长会话不爆 context — 触发过至少 1 次 compact 且对话可继续
- [ ] token 成本可见 — `cost.json` 数据齐全，预算告警跑通
- [ ] 缓存命中率 ≥ 70%（多轮会话 metric）
- [ ] 危险工具调用被 PreToolUse hook 拦截过 ≥ 1 次
- [ ] `/compact` 等至少 1 个 slash 命令可在 REPL 中跑通
- [ ] CI 全绿：lint + typecheck + unit + e2e smoke

---

## 八、风险提醒

| 风险 | 对策 |
|------|------|
| Compaction 摘要质量不稳定，压坏上下文 | M2 仅上基础版（token 触发 + 单步摘要）；回归基线留到 M4 eval 框架 |
| API 成本失控（开发中反复跑大上下文） | W8 之前先上 `obs/cost` 临时版（W5 即可加 token 累计），预算告警越早越好 |
| Hook 子进程超时 / 卡死 | 强制 30s 超时；hook 失败默认 fail-open（记录 warn，不阻断主流程）；可在 settings 切换 fail-closed |
| 三层记忆文件合并出现冲突 | 明确"后者覆盖前者"语义；同目录多文件取最高优先级（不合并）；sources 数组保留实际命中路径便于排查 |

---

## 九、与上下游的衔接

- **M1 已交付（依赖）**：runtime（config/logging/session）、core loop、registry/dispatcher、bash/read/write、permission、transcript writer
- **M3 将依赖 M2**：
  - MCP / Skills 注册流要复用 `ext/slash` 的命令分发机制
  - subagent 摘要返回主 loop 需要 `ctx/compact` 的摘要能力
  - Task Store metrics 需要 `obs/metrics` 已就位
- **M4 将扩展**：剩余 4 个 hook 事件、完整 OTel/Prometheus exporter、eval 回归基线
