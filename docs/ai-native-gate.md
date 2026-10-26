# Nova 的 AI-native 门禁

通用标准在 [`docs/ai-native-architecture.md`](./ai-native-architecture.md)：**4 层、14 个维度、0–5 分**。这份文档只说明 Nova 仓库如何落地自动门禁，以及哪些维度仍需人工评审。

> 自动门禁只覆盖可确定性判断的硬约束；它不等于完整的 AI-native 评分。不要因为 hook 通过就认为 14 个维度都达标。

## 1. 命令

```bash
pnpm ai-native:check        # 扫描全部已跟踪源码
pnpm ai-native:check:staged # 只扫描 staged 文件（pre-commit 使用）
```

## 2. pre-commit hook

仓库使用版本化的 `.githooks/pre-commit`：

- `pnpm install` 的 `prepare` 脚本把 `core.hooksPath` 指向 `.githooks`；
- 每次 `git commit` 前运行 `node scripts/check-ai-native.mjs --staged`；
- 有 **ERROR** 时退出码非 0，提交被拒绝。

手动安装（若 `prepare` 未运行）：

```bash
node scripts/install-git-hooks.mjs
```

若 `core.hooksPath` 已被设为其他目录，安装脚本不会覆盖；需要强制替换时设置 `AI_NATIVE_FORCE_HOOKS=1`。

## 3. 阻断规则（ERROR）

| 规则                | 检查                                                                                                               | 对应通用维度     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `model-isolation`   | `packages/model/src/**` 之外导入 `openai` / `@anthropic-ai/sdk`，或 `new OpenAI` / `new Anthropic`                 | 6 模型抽象与路由 |
| `provider-endpoint` | `packages/model/src/**` 之外出现 `api.openai.com` / `api.anthropic.com` 直连                                       | 6 模型抽象与路由 |
| `core-leaf`         | `packages/core/src/**` 导入任何 `@nova/*` 包                                                                       | 11 扩展与组合    |
| `tool-contract`     | `packages/tools/src/**` 或 `packages/agent/src/**` 的 `definition: {}` 缺少 `name` / `description` / `inputSchema` | 3 工具/能力契约  |

## 4. 提醒规则（WARN）

| 规则              | 检查                                                                                    | 对应通用维度             |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| `ai-surface-test` | 改动 AI-facing surface（prompt/compactor/model/tool/config/loop）但没有 staged 测试文件 | 8 评估体系 · 14 工程流程 |

WARN 不阻断提交，但评审必须解释为什么不需要测试。需要严格模式时用 `--strict`。

## 5. 绕过

`git commit --no-verify` 可以绕过 hook，只允许在**紧急修复**时使用，且提交说明/PR 里必须写明原因。常规开发不允许绕过。

## 6. Nova 的人工评审重点

自动门禁之外，以下 Nova 特有的不变量必须在评审中确认：

### 上下文与 prompt

- 同一 epoch 内 system prompt 字节稳定，prefix cache 不被无意破坏。
- 压缩只追加 `<compacted>` 边界，不截断/替换历史。
- prompt/compactor 改动有测试或 eval；失败样本可回放。

### 状态与持久化

- 历史 append-only；不原地修改已持久化消息。
- 崩溃/中断/失败路径仍能持久化一致的 `tool_use` ↔ `tool_result` 配对。
- 并发写入被串行化；`post_commit` 或等价 durability 边界存在。

### 权限 / 沙箱 / worktree

- 新工具/新命令经过权限门，不绕过 `checkPermission`。
- 文件写入范围、命令 cwd、git 重定向等边界有测试。
- worktree 切换后的 `cwd`、权限根、sandbox 白名单、session 绑定一致。
- `enterWorktree` / `exitWorktree` 保持 `exclusive` 与批次屏障语义。

### 人机协作

- 高风险动作有审批；plan mode 是工具层硬限制，不只是 prompt。
- 中断、取消、`/rewind` 不会留下半完成状态。
- 审批/权限模式切换不破坏状态和 prompt cache。

### 扩展与组合

- 新能力通过 port / hook / tool registry / MCP / plugin 接入，不修改 core loop。
- 依赖方向符合 `CLAUDE.md` 的包依赖图。
- 工具、子 agent、插件不能通过组合扩权；子 agent 的 `excludeTools` 仍然有效。
- 新工具/子 agent 有 schema、description、prompt section 和权限故事。

### 当前已知缺口

这些不是 hook 能解决的，需要在季度自查中单独跟踪：

- `eval/replay.ts` 仍是空壳，`eval/cases` 没有黄金 case；模型/prompt 质量没有回归。
- 没有 CI；自动门禁只在本地、可被 `--no-verify` 绕过。
- 可观测性以本地 transcript/usage 为主，没有聚合指标和 trace。
- 没有数据飞轮：真实失败还没有稳定进入 eval 数据集。
- `sandbox.enabled` 默认关闭；prompt injection 的内容来源/污点追踪尚未建立。

## 7. 新增工具时的检查清单

- [ ] `definition` 有 `name` / `description` / `inputSchema`（自动检查）。
- [ ] 失败返回 `is_error: true`，错误信息对模型可操作。
- [ ] 有副作用时：权限、审批、沙箱行为明确。
- [ ] 会话级副作用（切换 workspace、改全局模式）声明 `exclusive`。
- [ ] 状态型工具声明 `executionKey`。
- [ ] 跨工具指导新增 `ToolPromptSection`，按最终工具集 gating。
- [ ] 至少单元测试；真实 I/O 工具加集成测试。
- [ ] 工具不会绕过权限门、沙箱或子 agent 的工具过滤。

## 8. 与通用标准的关系

- 通用标准定义「什么是 AI-native」和「怎么打分」；
- 本文件定义 Nova 的自动门禁和人工评审重点；
- 两者的交集是可自动化硬约束，差集是需要人判断的架构问题。

季度自查时先按通用标准的 4 层、14 维度打分，再用本文件的检查清单定位 Nova 的具体改进项。
