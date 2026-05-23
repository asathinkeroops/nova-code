# M4 · 第 4 个月 — 能上线

> 来源：`agent-harness-loop-architecture.html` · Roadmap M4（Week 13 → Week 16）
> 阶段目标：**硬化 + 沙盒 + Eval + GA**
> 里程碑：Week 16 · **GA 1.0** — 文档齐备 · sandbox 上线 · eval 通过 · 正式发布
> 验收：v1.0 发布 · 沙盒里跑陌生 prompt 不出事故 · eval 黄金集通过率 ≥ 基线

---

## 一、本期范围速览

| 周次 | 面 | 模块 | 交付物 |
|------|----|------|--------|
| W13 | F · isolation | `iso/sandbox` | macOS sandbox-exec + Linux bubblewrap，spawn 统一接口 |
| W13 | ! · safety | `safe/sandbox-fs` | 工具级 FS / 网络白名单，与 F 面 sandbox 协同 |
| W14 | ! · safety | `hooks 全集` | SessionStart / SessionEnd · PreCompact · Notification · SubagentStop |
| W14 | F · isolation | `iso/eventbus` | EventEmitter 暴露进程/任务生命周期事件 |
| W15 | G · external | `ext/transport` | HTTP API（Hono）+ VS Code 扩展（webview + LSP 风格） |
| W15 | H · obs | `obs/eval` | transcript replay 框架 + 10–20 case 黄金集 + 回归基线 |
| W16 | — | `加固周` | 性能 / 错误兜底 / 安全审计 / 文档 + 5 个示例 |
| W16 | — | `v1.0 release` | tag · changelog · npm publish（内部 registry）· 上线公告 |

> 涉及包：`packages/isolation`（新启用）、`packages/safety`、`packages/external`、`packages/observability`、`apps/http`（新启用）、`apps/vscode`（新启用）

---

## 二、Week 13 — 沙盒（F + ! 面）

### 2.1 `iso/sandbox` · 进程沙盒

**目标**：所有 bash / subagent 子进程都走沙盒包装；CPU、内存、网络、文件系统按 settings 配置限额。

> 平台优先级（来自风险对策）：**macOS 优先**（团队主力机）→ **Linux 用 bubblewrap 兜底** → **Windows 留 v2**。

- [ ] 在 `packages/isolation/src/sandbox.ts` 实现统一 spawn 接口
  - [ ] API：`sandboxSpawn(cmd, args, profile): ChildProcess`
  - [ ] 自动检测平台并选择后端：darwin → sandbox-exec / linux → bubblewrap
- [ ] **macOS 后端**：sandbox-exec profile（`.sb` 文件）
  - [ ] 默认 profile：禁出站网络 / 禁写非工作目录 / 禁 fork 服务
  - [ ] 可在 settings.json 覆盖；profile 文件支持插值（`${WORKDIR}` / `${HOME}`）
  - [ ] 写一份 `sandbox.bash.sb` 给 bash 工具用，`sandbox.subagent.sb` 给子 agent 用
- [ ] **Linux 后端**：bubblewrap (`bwrap`)
  - [ ] 默认：unshare network / read-only `/usr` / writable workdir / 禁 ptrace
  - [ ] 等价 macOS profile 的功能集
- [ ] **资源限额**（与 sandbox 后端无关，走 `setrlimit` / cgroup）
  - [ ] CPU 时长（默认 60s/调用）
  - [ ] 内存（默认 512MB）
  - [ ] 最大文件描述符（默认 256）
- [ ] settings.json：
  ```jsonc
  "isolation": {
    "sandbox": {
      "enabled": true,
      "profile": "default",
      "limits": { "cpuSec": 60, "memMb": 512, "fdMax": 256 }
    }
  }
  ```
- [ ] 失败模式：sandbox 启动失败默认 **fail-closed**（拒绝执行），settings 可切 fail-open（warn 但放行）
- [ ] 与 `multi/subagent` 联动：subagent 子进程默认套 sandbox
- [ ] 测试：在沙盒内试图 curl 外网 → 拒绝；试图写 /etc → 拒绝；超 CPU → kill；happy path 跑通

### 2.2 `safe/sandbox-fs` · 工具级 FS / 网络白名单

**目标**：在 F 面沙盒之上，再加一层"工具内部白名单"。沙盒是硬隔离，sandbox-fs 是软声明（更易配置、更易绕过的 sanity check）。

- [ ] 在 `packages/safety/src/sandbox-fs.ts` 实现
  - [ ] 读取 settings.json 中的 `safety.fs.allowedPaths` / `safety.net.allowedHosts`
  - [ ] read / write / edit 之前校验路径在白名单内
  - [ ] webfetch 之前校验 host 在白名单内
- [ ] dispatcher 串联：`dispatch → permission → sandbox-fs → invariants → tool`
- [ ] 与 F 面 `iso/sandbox` 协同：sandbox-fs 是 belt-and-suspenders 的"suspenders"，sandbox 是硬"belt"
- [ ] 默认白名单：当前 cwd（递归）+ `/tmp` + session dir；其他需显式配置
- [ ] 拒绝信息可读：`"Path /etc/passwd is outside allowed workspace. Allowed: [<list>]"`
- [ ] 测试：白名单外路径被拒；白名单内允许；通配符模式 `**` 支持

---

## 三、Week 14 — Hooks 全集 + EventBus

### 3.1 `hooks 全集` · 补齐剩余 4 个事件

**目标**：M2 已上 PreToolUse / PostToolUse / UserPromptSubmit / Stop；M4 补齐其余 4 个，总共 8 个事件。

- [ ] 在 `packages/safety/src/hooks.ts` 扩展事件分发
- [ ] **SessionStart**：CLI 启动、新建 session 时触发
  - [ ] hook input：`{ session_id, cwd, resume_from?: string }`
  - [ ] 典型用途：写 motd、加载团队级 prompt、注入环境变量
- [ ] **SessionEnd**：CLI 退出、session 关闭时触发
  - [ ] hook input：`{ session_id, duration_sec, cost_usd, message_count }`
  - [ ] 典型用途：上报成本到内部 dashboard、清理临时文件
- [ ] **PreCompact**：`ctx/compact` 触发自动压缩之前
  - [ ] hook input：`{ session_id, trigger: "auto" | "manual", focus?: string, estimated_tokens }`
  - [ ] hook 可 `block`（阻止压缩）或 `pass`
  - [ ] 与 M2 的 `compact.ts` 联动（M2 已留接口）
- [ ] **Notification**：模型需要用户注意时（permission ask、长任务完成等）
  - [ ] hook input：`{ session_id, type: "permission" | "task_done" | "error", message }`
  - [ ] 典型用途：系统通知（macOS osascript / Linux notify-send）
- [ ] **SubagentStop**：subagent loop 结束时（成功 / 失败 / kill）
  - [ ] hook input：`{ parent_session_id, subagent_id, status, summary, cost_usd }`
  - [ ] 与 `iso/eventbus` 联动（事件源自 eventbus）
- [ ] hook 配置 schema 更新（`packages/runtime/src/config.ts`）
- [ ] 全部 8 个 hook 走相同的 fail-open / fail-closed / 30s 超时机制（M2 已定）
- [ ] 测试：每个新 hook 写一个"日志型"示例，确认事件触发时机正确

### 3.2 `iso/eventbus` · 生命周期事件总线

**目标**：把进程 / 任务生命周期事件统一发布到 EventEmitter，供 observability、hooks、orchestration 订阅。

> 设计原则：observability 通过事件订阅介入其他面，**绝不反向 import**（M2 依赖方向已定）。

- [ ] 在 `packages/isolation/src/eventbus.ts` 实现
  - [ ] 基于 Node `EventEmitter`（默认实现，零依赖）
  - [ ] 事件类型 + 载荷用 zod schema 严格定义
- [ ] 事件清单：
  - [ ] `process.spawn` / `process.exit` — bash / subagent / hook 子进程
  - [ ] `task.created` / `task.status_changed` / `task.completed` — Task Store
  - [ ] `subagent.spawn` / `subagent.summary` / `subagent.error`
  - [ ] `loop.iteration_start` / `loop.iteration_end`
  - [ ] `compact.started` / `compact.finished`
  - [ ] `permission.asked` / `permission.granted` / `permission.denied`
- [ ] 订阅者
  - [ ] `obs/metrics` 订阅 → 转 OTel metric
  - [ ] `obs/transcript` 订阅 → 写 JSONL
  - [ ] `safe/hooks` 订阅 → 触发对应的 hook 事件（SubagentStop ← subagent.summary）
- [ ] 错误隔离：单个订阅者抛错不影响其他订阅者；通过 `error` 事件统一报告
- [ ] settings.json：`observability.events.enabled`、`observability.events.bufferSize`
- [ ] 测试：事件按顺序到达；订阅者抛错不影响兄弟订阅者

---

## 四、Week 15 — Transport 多前端 + Eval

### 4.1 `ext/transport` · HTTP + IDE

**目标**：除了 M1 的 CLI REPL，再上 HTTP API（Hono）和 VS Code 扩展。

> 范围约束（来自风险对策）：**IDE 只保 VS Code**，JetBrains 留 v2。

#### 4.1.1 HTTP API（`apps/http`）

- [ ] 用 Hono 实现，基于现有 packages/core 的 loop
- [ ] 端点：
  - [ ] `POST /sessions` — 新建会话；返回 session_id + SSE endpoint URL
  - [ ] `GET /sessions/:id/stream` — SSE 流式返回 messages / tool_use / tool_result 事件
  - [ ] `POST /sessions/:id/messages` — 追加 user message
  - [ ] `POST /sessions/:id/abort` — 中断当前 loop
  - [ ] `GET /sessions` / `GET /sessions/:id` — list / detail（复用 `rt/session` 索引）
- [ ] 认证：bearer token（从 settings 读取静态 token，多租户留 v2）
- [ ] 复用 `obs/metrics` 的 `/metrics` endpoint，加 HTTP-specific 指标
- [ ] 默认端口 8765，可配置
- [ ] 测试：HTTP smoke（curl + SSE 客户端）

#### 4.1.2 VS Code 扩展（`apps/vscode`）

- [ ] 形态：webview + 自定义协议（LSP 风格 message framing；不强依赖 LSP 框架）
- [ ] 复用 HTTP API 作为 transport（VS Code 扩展连本地 nova daemon）
- [ ] 视图：
  - [ ] 侧边栏：session 列表 + new session 按钮
  - [ ] webview 主视图：当前 session 的 messages 流 + 用户输入框
  - [ ] permission ask 通过 VS Code 原生 `vscode.window.showQuickPick`
- [ ] command palette：`Nova: New Session` / `Nova: Resume Last` / `Nova: Show Logs`
- [ ] 打包：`vsce package` 产物在 release artifact 里
- [ ] 测试：手动跑通（M4 加固周做记录）

### 4.2 `obs/eval` · 回归基线

**目标**：transcript replay 框架 + 10–20 case 黄金集 + 回归基线，作为 M4 验收和未来 v2 防回归的工具。

> 范围约束（来自风险对策）：**黄金集 ≤ 20 case**，避免无限膨胀。

- [ ] 在 `packages/observability/src/eval.ts` 实现 transcript replay
  - [ ] 输入：一段 JSONL transcript（user message + 期望最终产物 / 状态）
  - [ ] 跑法：把 user message 喂给 base harness，等 loop end_turn
  - [ ] 评估：用 LLM-as-judge 比对最终产物 vs 期望，或用确定性 checker（文件存在 / 内容匹配）
- [ ] `eval/cases/` 目录结构：
  ```
  eval/cases/
  ├── 01-write-quicksort.jsonl
  ├── 02-debug-failing-test.jsonl
  ├── 03-add-feature-with-mcp.jsonl
  ├── ...
  └── README.md  # 描述每个 case 的目标和 checker 类型
  ```
- [ ] **case 选择原则**：覆盖 8 个面（A–H）+ 关键能力组合
  - [ ] 至少 2 个 MCP 集成 case
  - [ ] 至少 2 个 subagent 调用 case
  - [ ] 至少 2 个长会话 / compact case
  - [ ] 至少 1 个 permission 拦截 case（期望被拒）
- [ ] `eval/replay.ts` 主入口
  - [ ] CLI：`pnpm eval run` / `pnpm eval run --case <id>`
  - [ ] 输出：通过率 + 每个 case 的 cost / latency / token 使用
- [ ] **回归基线**：W15 末跑一次完整 eval，结果写入 `eval/baseline.json`；之后每次 PR 跑 eval，通过率 ≥ baseline
- [ ] CI 集成：每周一次定时 eval（`.github/workflows/eval.yml`），失败发通知
- [ ] 测试：eval 框架自身的单测（mock LLM）

---

## 五、Week 16 — 加固 + 发布

### 5.1 加固周

#### 5.1.1 性能

- [ ] **冷启动**：`harness` 命令首次执行 → loop 第一轮 LLM call 之间 ≤ 1.5s（除 LLM 网络延迟）
  - [ ] 用 `--inspect` profile 一次，识别热点
  - [ ] 延迟加载非必要包（cosmiconfig 配置项、OTel 等）
- [ ] **内存**：长跑 1 小时 / 100 轮的 session，常驻内存 ≤ 300MB
  - [ ] 检查 transcript writer 是否有积压
  - [ ] 检查 eventbus 订阅是否泄露
- [ ] **token 缓存命中率**：保留 M2 的 ≥ 70% 硬指标，加固周再确认

#### 5.1.2 错误兜底

- [ ] 全部公开 API 路径上的 `throw` 审一遍 —— 是否给模型可读错误？是否会让 loop 死循环？
- [ ] LLM API 速率限制 / 5xx：指数退避重试 ≤ 3 次
- [ ] Anthropic API 异常 stop_reason：兜底返回安全终止（已在 M1 五态机覆盖，再回归一遍）
- [ ] sandbox 启动失败 / hook 子进程 crash：路径全部 fail-closed 默认 + warn 日志
- [ ] better-sqlite3 文件锁冲突：重试 3 次 + 给出"另一个 nova 实例在跑？"的提示

#### 5.1.3 安全审计

- [ ] **走一遍 `/security-review` skill**（项目自带）
- [ ] 检查清单：
  - [ ] 任意工具能否绕过 permission（dispatcher 必经路径 — 写 1 个绕过测试）
  - [ ] MCP server 输入是否会引发 prompt injection（明确文档：external content 是 untrusted）
  - [ ] hook 子进程是否可读敏感环境变量（默认 sanitize）
  - [ ] webfetch 是否会跟随重定向到 file:// / localhost（明确禁止）
  - [ ] subagent transcript 是否会泄露父 session 敏感数据（默认隔离 + 摘要前过滤）
- [ ] 渗透测试：选一个团队成员 red team 试图让 base harness 做坏事
- [ ] 修复发现的问题，产出 `docs/SECURITY.md`

#### 5.1.4 文档

- [ ] `docs/` 完整化
  - [ ] `ARCHITECTURE.md` — 把 HTML 架构图的 7+1 面用 markdown 重写一遍
  - [ ] `GETTING_STARTED.md` — 5 分钟从安装到第一次跑通
  - [ ] `CONFIGURATION.md` — 所有 settings.json 字段一览（自动从 zod schema 生成）
  - [ ] `PLUGINS.md` — 怎么写 MCP server / Skill / Slash command / Hook
  - [ ] `API_REFERENCE.md` — packages/sdk 暴露的公开 API
  - [ ] `SECURITY.md` — 安全模型 + threat model + 已知限制
  - [ ] `TROUBLESHOOTING.md` — 常见问题
- [ ] 每个 package 的 `README.md` 同步更新
- [ ] CLAUDE.md / NOVA.md 给团队一份"用 nova 干活的最佳实践"

#### 5.1.5 5 个示例（`examples/`）

> 路径在架构文档已规划：`examples/01-hello-cli/` … `examples/05-subagent-flow/`

- [ ] `01-hello-cli/` — 最小可跑示例（bash + read + write）
- [ ] `02-custom-tool/` — 写一个自定义工具并注册
- [ ] `03-mcp-server/` — 写一个最小 MCP server 并接入
- [ ] `04-skill-pack/` — 写一个 SKILL.md + 引用文件
- [ ] `05-subagent-flow/` — 主 loop 用 Task 工具 spawn 子 agent 协作
- [ ] 每个示例有 README + 可一键运行的脚本

### 5.2 v1.0 Release

- [ ] **版本号**：根 + 各 package 升 `1.0.0`（用 changesets）
- [ ] **CHANGELOG**：M1 → M4 全期变更聚合一份完整 CHANGELOG
- [ ] **tag**：`v1.0.0`，附带 release notes
- [ ] **npm publish**：发布到**内部 registry**（前提 ④ 明确：不是公网 npm）
  - [ ] 用 `pnpm publish -r --filter "./packages/*"` 批量发包
  - [ ] 发布前 dry-run 一次
- [ ] **VS Code 扩展**：`vsce package` 产物上传到内部 marketplace 或 release artifact
- [ ] **HTTP API Docker 镜像**：`apps/http` 出一个 Dockerfile + image push（如果团队有内部 registry）
- [ ] **上线公告**
  - [ ] 内部 wiki / Slack 发布
  - [ ] 含：能力概述、安装方式、5 个示例 link、SECURITY.md link、反馈渠道

---

## 六、跨项要求（贯穿 W13–W16）

- [ ] **依赖方向**（CI 强制）
  - isolation → runtime
  - safety → runtime
  - external → core + tools + runtime
  - observability → runtime（事件订阅）
- [ ] **跨平台**：macOS + Linux 双平台 CI（前提 ④）；Windows 留 v2，PR 模板里加"非 Windows-only 变更"勾选项
- [ ] **eval 通过率**：每个 PR 跑回归 eval；通过率不降
- [ ] **transcript 兼容**：M4 新事件（hooks 全集、eventbus、sandbox）全部落 JSONL
- [ ] **Vitest 覆盖率**：核心包整体 ≥ 70%

---

## 七、M4 验收清单（GA 1.0）

> Week 16 末统一过一次

- [ ] **沙盒**：bash / subagent 默认在 sandbox 内跑；陌生 prompt 试 30 个 "破坏性"指令，零 escape
- [ ] **Hooks 全集**：8 个事件全部可配置、可触发、可拦截
- [ ] **HTTP API**：curl + SSE 端到端跑通；JS client 接入示例
- [ ] **VS Code 扩展**：从 marketplace 装包后能新建 / resume / 跑 session
- [ ] **Eval**：黄金集 ≥ 10 case；通过率 ≥ baseline（W15 末快照）
- [ ] **冷启动 ≤ 1.5s** · **常驻内存 ≤ 300MB**
- [ ] **安全审计**：发现问题全部 close 或文档化为 known limitation
- [ ] **5 个示例**：每个能在 `pnpm install && pnpm run example:NN` 跑通
- [ ] **文档**：7 篇核心文档齐全；新人能从零跑通
- [ ] **v1.0 发布**：npm 内部 registry 见到 1.0.0；上线公告已发
- [ ] **CI 全绿**：lint + typecheck + unit + e2e + eval + dependency-cruiser + 跨平台 matrix

---

## 八、风险提醒

| 风险 | 对策 |
|------|------|
| 跨平台 sandbox 工程量大 | 优先 macOS（团队主力机），Linux 用 bubblewrap 兜底；Windows **明确留 v2** |
| Scope 超载，加固周吃不下 | 加固周本就是 P0 收尾兜底（来自风险对策）；非关键文档可顺延，发布优先 |
| Eval LLM-as-judge 不稳定 | 优先确定性 checker（文件 / 状态匹配）；LLM judge 只用在自由文本场景，且复测 3 次取多数 |
| HTTP API 安全边界 | 默认绑 127.0.0.1；公开访问需显式打开 + bearer token；多租户 / OAuth 留 v2 |
| VS Code 扩展 webview 安全 | CSP 严格策略；webview 与扩展进程通过 message passing，不直接执行远程脚本 |
| 内部 registry 发布权限/凭据 | W15 提前确认凭据；W16 提前演练一次 publish dry-run |
| 文档铺太厚导致维护负担 | 7 篇文档定数；新增内容优先合并到现有文档，不开新章 |

---

## 九、与上下游的衔接

- **M3 已交付（依赖）**：MCP / Skill / Subagent / Background / Task Store / Session resume / OTel metrics
- **本期复用 M3 的能力**：
  - sandbox 包裹 subagent 子进程（M3 的 child_process.fork 升级为"fork + sandbox spawn"）
  - SubagentStop hook 订阅 M3 的 eventbus 事件
  - HTTP transport 复用 M3 的 `/metrics` endpoint 与 session 索引
  - eval 黄金集复用 M3 的 transcript 格式
- **v2 储备（本期不做）**：
  - F · iso/worktree
  - E · multi/mailbox · multi/protocol · multi/team · multi/autonomy
  - IDE 第二款（JetBrains）+ Web UI
  - Windows sandbox（AppContainer / Job Object）
  - 多模型适配（OpenAI / 本地模型）
  - Hosted / Marketplace 多租户
