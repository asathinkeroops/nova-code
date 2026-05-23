# M3 · 第 3 个月 — 能集成 & 能分身

> 来源：`agent-harness-loop-architecture.html` · Roadmap M3（Week 9 → Week 12）
> 阶段目标：**外部接入 + 短命 subagent + 持久编排**
> 里程碑：Week 12 · **Beta** — 扩展到 10–20 内部用户，收集观测数据
> 验收：能接 ≥3 个 MCP server · subagent（共用 cwd）跑通 · Task Store 跨会话保留任务图与依赖 · 从昨天会话 resume 不丢上下文

---

## 一、本期范围速览

| 周次 | 面 | 模块 | 交付物 |
|------|----|------|--------|
| W9 | G · external | `ext/mcp` | StdioClientTransport → StreamableHTTPClientTransport |
| W9 | G · external | `ext/skills` | SKILL.md 索引 + Skill 工具（渐进披露） |
| W10 | E · multi-agent | `multi/subagent` | Task 工具：worker_threads 隔离 messages[] · 摘要回主 loop |
| W10 | D · orchestration | `orch/todo` | createTodo / updateTodo / getTodos 工具 + 单会话计划状态机 |
| W11 | D · orchestration | `orch/bg` | bash `run_in_background` + readline pipe + 事件回注 |
| W11→12 | D · orchestration | `orch/tasks` | Task Store · better-sqlite3 跨会话任务图 + 依赖 |
| W12 | rt · runtime | `rt/session` | 完整 resume / fork（多分支） + session 索引 |
| W12 | H · obs | `obs/metrics` | OpenTelemetry exporter + Prometheus `/metrics` endpoint |

> 涉及包：`packages/external`、`packages/multi-agent`（新启用）、`packages/orchestration`（新启用）、`packages/runtime`、`packages/observability`

---

## 二、Week 9 — 外部接入（G 面）

### 2.1 `ext/mcp` · MCP 客户端

**目标**：接入 Model Context Protocol，把外部工具注册进 base harness 的 tool registry，统一走 dispatcher + safety。

> 设计要点：MCP 工具与 builtin 在 dispatcher 之上完全同构 —— 同样的 permission/hooks/invariants 都生效。

- [ ] 在 `packages/external/src/mcp/client.ts` 实现 MCP client wrapper（基于 `@modelcontextprotocol/sdk`）
  - [ ] 锁定 SDK 版本；adapter 层把 MCP `tools/list` 翻译为 base harness `Tool` 接口
  - [ ] 工具 description 透传；name 加 server 前缀避免冲突（`<server>__<tool>`）
  - [ ] 错误信息保留原始堆栈，但向模型返回可读文本
- [ ] **W9 上半**：`packages/external/src/mcp/stdio.ts` — StdioClientTransport
  - [ ] 启动子进程（execa），stdin/stdout 走 JSON-RPC
  - [ ] 进程崩溃自动重连（指数退避，最多 3 次）
- [ ] **W9 下半**：`packages/external/src/mcp/http.ts` — StreamableHTTPClientTransport
  - [ ] 支持 bearer token / headers 注入（从 settings.json）
  - [ ] SSE 长连接的断线重连
- [ ] settings.json 配置项：
  ```jsonc
  "mcp": {
    "servers": {
      "github": { "type": "stdio", "command": "npx", "args": ["@github/mcp"] },
      "linear": { "type": "http", "url": "https://...", "headers": {...} }
    }
  }
  ```
- [ ] 注册流：启动时按 server 顺序拉 `tools/list`，注册到 registry；遇到失败的 server 记 warn 但不阻断启动
- [ ] permission rule 支持 `mcp:<server>:<tool>` 形式的匹配
- [ ] 单元 + e2e：mock MCP server（stdio）跑 happy path、超时、协议错误

### 2.2 `ext/skills` · Skill 渐进披露

**目标**：把"知识载体 TIER 3"落到代码 —— SKILL.md 描述「何时该用」，模型调用 Skill 工具时按需返回完整内容 + 引用文件。

> 设计原则（来自架构文档"知识载体三档"）：**doc 是「告诉模型怎么做」，skill 是「替模型做掉」**。SKILL.md 只暴露"何时用"，避免一次性把所有 SOP 塞进 system prompt。

- [ ] 在 `packages/external/src/skills.ts` 实现：
  - [ ] 扫描位置：`{workspace}/.skills/**/SKILL.md` + `~/.nova/skills/**/SKILL.md`
  - [ ] 解析 front-matter：`name` / `description` / `triggers` / `files`
  - [ ] 构建索引：`{ name, description, location }` 注入 system prompt（仅元信息，不含正文；`location` 为 skill 目录绝对路径）
- [ ] 注册内置 `loadSkill` 工具
  - [ ] 入参：`name: string`、可选 `args: string`
  - [ ] 返回：SKILL.md 正文 + `files` 列表中按需读取的引用文件内容
  - [ ] 限制单次返回总 token（默认 4000），超出则提示模型分多次调用
- [ ] 与 `ctx/cache` 联动：SKILL.md 索引部分加入 system prompt 缓存断点
- [ ] 测试：放一个 `01-hello-skill/SKILL.md`，确认模型能"按需"取到内容；不调用 Skill 时正文不入上下文

---

## 三、Week 10 — Subagent + Todo（E + D 面）

### 3.1 `multi/subagent` · 短命子 loop

**目标**：Task 工具：spawn 隔离的子 agent loop，跑完任务后摘要返回主 loop。

> 范围限制（来自前提 ③）：本期**只做短命 subagent**，共用主仓 cwd，不引入 worktree。Agents Team / Autonomy / Mailbox / Protocol 全部标 P1，留 v2。

- [ ] 在 `packages/multi-agent/src/subagent.ts` 实现 Task 工具背后逻辑
- [ ] 在 `packages/multi-agent/src/worker.ts` 实现进程/线程隔离
  - [ ] **MVP 走 `child_process.fork`**（M3 风险对策：worker_threads 复杂度先回避）
  - [ ] 子进程独立 messages[]、独立 cost 计数；共享 cwd 和 session 目录
  - [ ] 父子 IPC：父进程通过 stdin 发任务，子进程通过 stdout 流式回事件
  - [ ] 子进程异常退出 → 主 loop 收到错误结果，不影响主进程
- [ ] 子 agent 的工具集
  - [ ] 默认继承父的 tool registry（read / write / edit / bash / glob / grep ...）
  - [ ] 不允许子 agent 再 spawn 子 agent（防 fork bomb）
- [ ] 在 `packages/multi-agent/src/summarize.ts` 实现摘要回写
  - [ ] 子 loop end_turn 时把整段 messages[] 跑一遍 LLM 摘要
  - [ ] 主 loop 收到的 tool_result 只含摘要 + 关键产物路径（不灌全部子对话）
- [ ] 注册到 `packages/tools/src/builtin/task.ts`（已在 M1 占位）
  - [ ] 入参：`description` / `prompt` / `subagent_type`（可选，留给 v2）
- [ ] permission：Task 工具默认需要 `ask`（防止意外 spawn）
- [ ] 观测：每个 subagent 单独 transcript 子目录 `session.dir/subagents/<id>/`
- [ ] 测试：spawn 一个子 agent 写文件 → 摘要返回 → 父 loop 能继续基于结果工作

### 3.2 `orch/todo` · Todo 工具组

**目标**：单会话内的有序计划状态机，给模型一个"显式 working memory"。

> 与 `orch/tasks` 的区别：todo 是**单会话内存中的 working memory**（进程退出即丢）；tasks 是**跨会话工作图**（落 SQLite，带依赖关系、状态机、产物记录）。

- [x] 在 `packages/orchestration/src/todo.ts` 实现状态机（`TodoStore` 类，模块级单例由 `builtinTools()` 注入）
  - [x] Todo 结构：`{ id: string, description: string, status: TodoStatus }`
  - [x] 四态：`pending` / `in_progress` / `completed` / `error`
  - [x] **不变量**：同时只能有一个 `in_progress`；违反时 `updateTodo` 直接抛 `TodoError`，由工具层翻成 `isError`
  - [x] 允许的状态迁移：
    - `pending → in_progress / completed / error`
    - `in_progress → completed / error / pending`
    - `completed → pending`（重新打开）
    - `error → pending`（重试，不带 message）
  - [x] id 由工具内部生成（`crypto.randomBytes(6).toString("base64url")` —— 替代原计划的 nanoid，避免新增依赖，效果等同：8 字符 URL-safe 短 id）
  - [x] description 一旦写入即不可变（`updateTodo` schema 用 `strict()` 拦截多余字段）
- [x] 注册三个工具（`packages/tools/src/builtin/todo/{create,update,get}.ts`，统一由 `createTodoTools(store)` 装配；旧 `todo-write.ts` 占位文件已删除）
  - [x] `createTodo`：入参 `{ description }` → 返回完整 todo JSON
  - [x] `updateTodo`：入参 `{ id, status }` → 返回更新后的 todo（仅可改 status）
  - [x] `getTodos`：入参 `{ status? }`（可按状态过滤）→ 返回 todo 列表
  - [x] `builtinTools()` 接受可选 `TodoStore`，默认创建新实例；同一 store 串通三个工具
- [x] 状态仅保存在内存（进程生命周期内有效，不落盘；resume session 时 todos 重置为空）
- [ ] CLI 在 REPL 顶部展示当前 in_progress 条目 + 各状态计数（Ink 渲染）—— **未做**，CLI 集成留到 W12 verfication 阶段统一接
- [x] 测试：
  - [x] 状态机层 `packages/orchestration/src/todo.test.ts`（15 case）
  - [x] 工具层 `packages/tools/src/builtin/todo/todo.test.ts`（11 case）
  - [x] 覆盖：仅一个 in_progress 拒绝、`updateTodo` 拒收 description、`completed/error → pending` 反向迁移、自迁移拒绝、id 唯一性（500 次无碰撞）、`getTodos` 状态过滤

---

## 四、Week 11 — Background + Task Store（D 面持久层）

### 4.1 `orch/bg` · 后台任务

**目标**：长跑命令（dev server / 编译 / 测试 watch）走 background，stdout 流式回注 messages[]，不阻塞主 loop。

- [ ] 在 `packages/orchestration/src/background.ts` 实现
  - [ ] bash 工具新增 `run_in_background: boolean` 参数
  - [ ] 启动后立即返回 `{ shellId, pid }`，进程继续在后台跑
  - [ ] stdout/stderr 走 readline → 每行作为事件追加到 ringbuf（默认 1000 行）
- [ ] 新增工具 `BashOutput`
  - [ ] 入参：`shellId` / 可选 `filter`（regex）
  - [ ] 返回：自上次读取以来的新 stdout 行
- [ ] 新增工具 `KillShell`
  - [ ] 优雅 SIGTERM → 3s 超时 → SIGKILL
- [ ] 事件回注 messages[]：后台进程退出时往 messages[] 追加一条 user message `[Background process <id> exited with code N]`
- [ ] 与 `safe/permission` 联动：`run_in_background` 默认需要 `ask`
- [ ] 测试：跑一个 `sleep 60` 的后台进程，主 loop 期间能反复读到输出，最后能 kill

### 4.2 `orch/tasks` · Task Store（W11 → W12）

**目标**：跨会话的任务图持久层，让"昨天的 todo / 子任务"今天能继续。

> 与 `orch/todo` 的区别：todo 是**单会话 working memory**；tasks 是**跨会话工作图**（带依赖关系、状态机、产物记录）。

- [ ] **W11**：基础 schema 与 CRUD
  - [ ] 引入 `better-sqlite3`（同步 API，启动快，单文件 `~/.nova/tasks.db`）
  - [ ] 表结构：`tasks(id, title, status, parent_id, created_at, updated_at, ...)`、`task_deps(task_id, depends_on)`、`task_artifacts(task_id, path, kind)`
  - [ ] 状态机：`pending` / `in_progress` / `blocked` / `completed` / `cancelled`
  - [ ] CRUD API：`createTask` / `updateStatus` / `linkDependency` / `listTasks(filter)` / `getTaskGraph(rootId)`
- [ ] **W12**：工具暴露 + UX
  - [ ] 注册 `TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet` / `TaskStop` 工具
  - [ ] 启动时 CLI 在 `--continue` 模式下打印 active tasks 概要
  - [ ] 依赖图校验：成环检测；完成一个 task 时自动把后继 blocked → pending
- [ ] 与 session 关联：每个 task 可绑定 `created_session_id`，方便回到原会话查 transcript
- [ ] 测试：跨进程写同一个 DB；依赖图 CRUD；状态机非法迁移被拒

---

## 五、Week 12 — Session 完整化 + Metrics 升级

### 5.1 `rt/session` · resume / fork 完整版

**目标**：M1 只有"session dir 雏形"；M3 把跨日 resume、多分支 fork 补齐。

- [ ] 在 `packages/runtime/src/session.ts` 扩展
  - [ ] **resume**：`harness --resume <session-id>` 加载该 session 的 messages[]、todos、cost、cache 上下文
  - [ ] **fork**：`harness --fork <session-id>` 复制 messages[] 到新 session，原会话不受影响（用于"探索不同路径"）
  - [ ] **list**：`harness --list-sessions` 输出最近 N 个会话（按时间 + label 排序）
- [ ] Session 索引：`~/.nova/sessions/index.jsonl`
  - [ ] 每个 session 一行：`{ id, cwd, started_at, last_used_at, title, label?, cost_usd }`
  - [ ] 启动时增量更新；不读取全部 transcript（避免慢启动）
- [ ] Session title 自动生成：首轮 user message → 调 LLM 生成 ≤ 40 字的标题（缓存到 index）
- [ ] 与 `orch/tasks` 联动：resume 时打印"该 session 创建的 active tasks"
- [ ] 测试：fork 一个 session 后修改不影响原 session；resume 后 cost 累计接续

### 5.2 `obs/metrics` · OTel + Prometheus

**目标**：M2 的 metrics 只在 transcript 里；M3 接入 OpenTelemetry，可被外部观测系统抓取。

- [ ] 在 `packages/observability/src/metrics.ts` 接入 `@opentelemetry/sdk-node`
  - [ ] 配置 OTel resource：`service.name=nova`、`service.version=<pkg.version>`
  - [ ] Meter provider + Prometheus exporter
- [ ] 暴露 `/metrics` HTTP endpoint（默认 `127.0.0.1:9464`，可配置）
- [ ] 把 M2 的所有 metric 迁移到 OTel：
  - [ ] `nova_loop_iterations_total{session}`
  - [ ] `nova_tool_calls_total{tool, status}`
  - [ ] `nova_tool_duration_seconds{tool}` (histogram)
  - [ ] `nova_llm_tokens_total{kind=input|output|cache_read|cache_create}`
  - [ ] `nova_cache_hit_rate`（gauge）
  - [ ] `nova_cost_usd_total{session}`
- [ ] 新增 M3 专属 metric：
  - [ ] `nova_subagent_spawned_total`
  - [ ] `nova_subagent_duration_seconds` (histogram)
  - [ ] `nova_mcp_server_status{server}` (gauge: 1=up, 0=down)
  - [ ] `nova_task_store_size{status}` (gauge)
- [ ] settings.json：`observability.otel.{ enabled, endpoint, prometheusPort }`
- [ ] 测试：起 Prometheus（docker compose）抓 `/metrics`；确认核心指标可见

---

## 六、跨项要求（贯穿 W9–W12）

- [ ] **依赖方向**（CI 用 dependency-cruiser 强制 — M2 已铺）
  - external → core + tools + runtime
  - multi-agent → core + runtime
  - orchestration → core + runtime（`tasks.ts` 引入 better-sqlite3）
  - observability → runtime（只通过事件订阅）
- [ ] **新增 tool 必须有 description**：参考架构文档"③ 工具的标准"
  - 何时该用 / 何时不该用 / 错误信息可读 / 幂等性
- [ ] **transcript 兼容**：MCP 调用、subagent spawn、task 状态变更全部落 JSONL
- [ ] **Vitest 覆盖率**：每个新模块 ≥ 70%
- [ ] **settings schema 同步**：每加一个可配置项更新 `packages/runtime/src/config.ts`
- [ ] **e2e 黄金 case**：M4 eval 框架要用，W11 起开始攒 case（每个新工具至少 1 个）

---

## 七、M3 验收清单

> Week 12 末统一过一次

- [ ] **MCP**：接通 ≥ 3 个 MCP server（建议 github / linear / 一个本地 stdio）；任意一个 server 挂掉不影响主 loop
- [ ] **Skill**：放一个 `code-reviewer/SKILL.md`，模型在合适场景能主动调用并拿到正文
- [ ] **Subagent**：Task 工具能 spawn 子 loop 写文件，摘要回主 loop；父进程崩溃不残留僵尸进程
- [ ] **Todo**：createTodo / updateTodo / getTodos 四态机生效；单 in_progress 不变量被强制；description 不可变
- [ ] **Background**：`run_in_background` 的 bash 任务跑通；BashOutput / KillShell 工作
- [ ] **Task Store**：跨进程写同一个任务图；依赖关系 + 状态机非法迁移被拒
- [ ] **Resume**：`harness --resume <id>` 从昨天 session 接着干，cost / todo / messages 全在
- [ ] **Metrics**：Prometheus 能抓 `/metrics`；核心指标齐全
- [ ] **CI 全绿**：lint + typecheck + unit + e2e smoke + dependency-cruiser
- [ ] **Beta 用户**：≥ 10 名内部用户已切到 nova 干活，收集到 ≥ 100 条 transcript

---

## 八、风险提醒

| 风险 | 对策 |
|------|------|
| MCP 协议演进 SDK 可能 break | 锁版本 + adapter 层；@modelcontextprotocol/sdk 升级走 PR review |
| worker_threads 复杂度过高 | MVP 用 `child_process.fork`；性能瓶颈再升级 worker_threads |
| Subagent spawn 残留僵尸进程 | 父进程退出时 SIGTERM 所有子进程；记 PID 在 session dir，启动时清理 |
| better-sqlite3 跨进程并发写 | SQLite 默认 WAL 模式即可；高频写场景留个 batch 接口 |
| 后台进程 stdout 占内存 | ringbuf 默认 1000 行；超出滚动覆盖 |
| Skill 索引膨胀污染 system prompt | 索引格式紧凑（仅 name + description + location） |

---

## 九、与上下游的衔接

- **M2 已交付（依赖）**：context（memory/cache/compact）、tools/invariants、4 个核心 hook、slash 命令、obs/cost + metrics 基础
- **本期复用 M2 的能力**：
  - subagent 摘要走 `ctx/compact` 的摘要函数
  - MCP / Skill 注册流复用 `ext/slash` 的命令分发机制
  - Task Store metrics 走 M2 已起的 `obs/metrics`
- **M4 将依赖 M3**：
  - sandbox 包裹 subagent 子进程
  - 剩余 4 个 hook 事件需要 background / subagent 生命周期事件
  - eval 黄金集需要 Task Store + transcript 接管
  - HTTP transport 复用 obs metrics 的 `/metrics` endpoint


Swooping… (15s · ↑ 590 tokens · still thinking)