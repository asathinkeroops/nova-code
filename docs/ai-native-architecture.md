# AI-native 架构标准与提交门禁

这份文档是 Nova 仓库的 **AI-native 架构标准**，也是提交前自动检查的依据。目标不是给项目贴标签，而是让每次改动都能回答一个问题：

> 我们是在把模型当作系统的运行时一等公民，还是只是在确定性系统旁边加了一个大模型接口？

标准分两部分：

- **自动门禁**：`scripts/check-ai-native.mjs` 能确定性判断的硬约束；违反时 pre-commit hook 直接拒绝提交。
- **人工评审**：无法可靠静态判断、但必须在评审中逐项确认的架构问题。

---

## 1. 什么算 AI-native

AI-native 不是「接入了 LLM」，而是：

> 把概率性的模型当作系统的主要控制面之一，围绕它的不确定性设计上下文、工具、状态、权限、观测和评估；确定性代码负责提供能力、边界和保证。

区分：

- **AI-enabled**：原系统不变，在边缘加一个总结/分类/生成调用。
- **AI-native**：核心链路是「意图 → 规划 → 工具调用 → 环境反馈 → 修正」，模型在循环里。

**判断底线**：去掉模型，系统还剩下什么？如果只剩 CRUD，模型就是外挂；如果核心是模型循环、上下文、工具、状态和评估，才接近 AI-native。

---

## 2. Nova 的六条硬约束

### 2.1 模型访问必须隔离在 `@nova/model`

只有 `packages/model/src/**` 可以导入模型 SDK（`@anthropic-ai/sdk`、`openai`）或直接访问 provider 端点。其他包只依赖 `ModelClient` port。

**为什么**：provider 的协议、重试、鉴权、错误格式都属于模型适配层。泄漏到业务代码后，换模型、加 fallback、修正重试语义都会变成全局搜索。

**diff 里看什么**：

- 新出现 `import ... from "openai"` / `"@anthropic-ai/sdk"`；
- 新出现 `new OpenAI(...)` / `new Anthropic(...)`；
- 新出现 `https://api.openai.com` / `https://api.anthropic.com`；
- 在 `@nova/model` 之外构造 provider 请求。

### 2.2 `@nova/core` 是叶子

`packages/core/src/**` 不导入任何 `@nova/*` 工作区包、模型 SDK 或工具实现。核心需要什么能力，就在 `ports.ts` 声明 port，由外层实现。

**为什么**：core 是 agent kernel；它一旦知道某个具体包，扩展机制就会退化成 import 网。ESLint 已强制这一条，脚本再检查一次，防止规则被绕过。

### 2.3 工具是类型化能力，不是自由文本

每个 `ToolHandler` 的 `definition` 必须同时有：

- `name`：稳定的 wire 标识；
- `description`：模型据此决定何时调用；
- `inputSchema`：zod schema，dispatcher 在调用前验证。

工具还需要在评审中确认：

- 失败返回 `is_error: true`，错误信息对模型可操作；
- 有副作用的工具说明权限/审批行为；
- 会改动会话级状态的工具声明 `exclusive`（见 3.1）；
- 需要串行化的状态工具声明 `executionKey`；
- 新工具在最终工具集里可达，并更新了对应的 tool prompt section（若跨工具）。

### 2.4 上下文是受管状态

- 系统提示词只在 epoch 变化时重建；同一 epoch 内保持字节稳定（prefix cache）。
- 会话历史 append-only；压缩只能追加 `<compacted>` 边界，不能截断/替换。
- 上下文窗口有预算、压缩、检索和缓存策略；不能无限拼接。
- prompt、工具描述、上下文模板的变更必须可测试、可回放。

### 2.5 状态可回放，失败有确定语义

- 会话、消息、工具结果、文件快照可持久化；
- transcript 和 messages 能独立解释一次失败；
- 模型超时、上下文溢出、工具失败、权限拒绝、取消都有结构化结果；
- 不允许「模型失败后静默继续」或「工具失败但结果看起来成功」。

### 2.6 权限、沙箱、审计在模型之外

- 模型可以提议动作，但不能绕过权限引擎、OS 沙箱、审批和审计；
- 高风险动作有确认点；
- 凭据、租户/项目边界、文件写入范围是确定性约束，不交给模型判断。

---

## 3. 变更类型对应的评审清单

### 3.1 新增/修改工具

- [ ] `definition` 有 `name` / `description` / `inputSchema`（自动检查）。
- [ ] schema 是 zod，且 dispatcher 能给出可操作的校验错误。
- [ ] 工具失败返回结构化 `is_error`，不是抛异常穿透。
- [ ] 有副作用时：权限规则、审批、沙箱行为明确。
- [ ] 会话级副作用（切换 workspace、改全局模式）声明 `exclusive`，并说明批次屏障行为。
- [ ] 状态型工具声明 `executionKey`，避免同一资源并发丢更新。
- [ ] 需要跨工具指导时，新增 `ToolPromptSection`，按最终工具集 gating。
- [ ] 至少有单元测试；真实 I/O 工具加集成测试。

### 3.2 修改模型/provider

- [ ] 改动只在 `packages/model/src/**`，或通过 `ModelClient` port。
- [ ] provider 错误、重试、超时、取消、流式行为有测试。
- [ ] 窗口/max_tokens 计算走 `@nova/base` 的配置与 getter，不硬编码。
- [ ] 换模型/换 provider 不需要改业务代码。

### 3.3 修改 prompt / 上下文 / 压缩

- [ ] 同一 epoch 内 system prompt 字节稳定。
- [ ] prefix cache 不被无意破坏；压缩只追加边界。
- [ ] 有对应测试或 eval 场景；失败样本能被回放。
- [ ] 不把新的上下文拼接逻辑散落在业务代码里，走 prompt/compactor/memory 层。

### 3.4 修改状态 / 持久化

- [ ] 历史 append-only；不原地修改已持久化消息。
- [ ] 崩溃/中断/失败路径仍能持久化一致的配对（tool_use ↔ tool_result）。
- [ ] 并发写入被串行化；有 `post_commit` 或等价 durability 边界。
- [ ] 迁移逻辑有版本和回放测试。

### 3.5 修改权限 / 沙箱 / 安全

- [ ] 新工具/新命令经过权限门，而不是绕过。
- [ ] 文件写入范围、命令 cwd、git 重定向等边界有测试。
- [ ] 新凭据读取不进入模型上下文；敏感路径不被目录级授权覆盖。
- [ ] 高风险动作有审批和审计记录。

### 3.6 修改 CLI / UX

- [ ] 流式、打断、取消、错误展示有定义。
- [ ] 高风险操作有确认/撤销路径。
- [ ] 不把模型输出直接当控制指令执行。
- [ ] 用户可观察行为变更同步到 README、docs/guide、CLAUDE.md。

---

## 4. 自动门禁

### 4.1 命令

```bash
pnpm ai-native:check        # 扫描全部已跟踪源码
pnpm ai-native:check:staged # 只扫描 staged 文件（pre-commit 使用）
```

### 4.2 pre-commit hook

仓库使用版本化的 `.githooks/pre-commit`：

- `pnpm install` 的 `prepare` 脚本会把 `core.hooksPath` 指向 `.githooks`；
- 每次 `git commit` 前运行 `node scripts/check-ai-native.mjs --staged`；
- 有 **ERROR** 时退出码非 0，提交被拒绝。

手动安装（若 `prepare` 未运行）：

```bash
node scripts/install-git-hooks.mjs
```

### 4.3 阻断规则（ERROR）

| 规则                | 检查                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model-isolation`   | `packages/model/src/**` 之外导入 `openai` / `@anthropic-ai/sdk`，或 `new OpenAI` / `new Anthropic`                 |
| `provider-endpoint` | `packages/model/src/**` 之外出现 `api.openai.com` / `api.anthropic.com` 直连                                       |
| `core-leaf`         | `packages/core/src/**` 导入任何 `@nova/*` 包                                                                       |
| `tool-contract`     | `packages/tools/src/**` 或 `packages/agent/src/**` 的 `definition: {}` 缺少 `name` / `description` / `inputSchema` |

### 4.4 提醒规则（WARN）

| 规则              | 检查                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `ai-surface-test` | 改动 AI-facing surface（prompt/compactor/model/tool/config/loop）但没有 staged 测试文件 |

WARN 不阻断提交，但评审必须解释为什么不需要测试。需要严格模式时用 `--strict`。

### 4.5 绕过

`git commit --no-verify` 可以绕过 hook，只允许在**紧急修复**时使用，且提交说明/PR 里必须写明原因。常规开发不允许绕过。

---

## 5. 人工评审的 8 个问题

提交前/评审时快速自问：

1. 去掉模型，这个改动还剩下什么？模型是不是只在边缘？
2. 模型是否在核心循环里，能观察结果并修正？
3. 一次失败能否从 transcript/messages 完整回放？
4. 新工具是否有 schema、权限、沙箱、错误语义？
5. 上下文是否有预算、压缩、检索/缓存，而不是无限拼接？
6. 换模型/provider 是否需要改业务代码？
7. 模型超时、上下文溢出、工具失败时行为是否确定？
8. 有没有测试或 eval 覆盖这次 AI-facing 改动？

---

## 6. 评分（用于季度自查，不用于单次提交）

每个维度 0–3 分：

- 0：没有；
- 1：有，但临时拼的；
- 2：有明确设计，部分有测试；
- 3：有强制约束、自动化验证，换人或换模型仍稳定。

维度：控制流位置、上下文治理、工具契约、状态回放、失败语义、模型抽象、可观测性、评估体系、安全治理、人机协作、扩展性、成本/性能、数据飞轮、工程流程。

粗略判断：

- 0–12：AI-enabled；
- 13–24：AI-native 进行中；
- 25–36：较成熟的 AI-native 架构。

分数只用于自查；不要为了分数把确定性边界交给模型。

---

## 7. 一句话原则

**让模型负责理解、规划、取舍和探索；让代码负责权限、事务、幂等、审计、重试、限额和边界；让人负责高风险决策和最终批准。**
