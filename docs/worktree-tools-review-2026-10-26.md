# Worktree 工具改造审查（2026-10-26）

审查对象：nova-code 在基线提交 `46cde64` 之上的未提交改动，重点是将 `/worktree` 斜杠命令改为模型可调用的 `enterWorktree` / `exitWorktree` 工具。

本轮确认 **3 项问题：1 项 P1、2 项 P2**，均已在隔离的临时 Git 仓库中复现。现有 9 个相关测试文件、152 项测试和类型检查全部通过，但没有捕获下述场景。

本文独立记录本轮审查，不替代[此前的 worktree 审查记录](./worktree-review.md)，也不表示此前发现已全部修复。源码位置对应本轮审查时的工作区，后续定位应以函数名为准。本轮审查未修改实现代码。

## 问题概览

| 编号 | 优先级 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| WTT01 | P1 | 切换成功后，同一回合的工具仍操作旧目录 | `createWorktreeHost.enter`、`runTurn`、`createToolHost` |
| WTT02 | P2 | 并发切换导致工作区、权限和持久化绑定不一致 | `createEnterWorktreeTool`、`setWorkspace`、工具并发调度 |
| WTT03 | P2 | 新增工具遗漏 plan 模式的只读限制 | 工具注册、`resolveModeDecision` |

## WTT01：切换成功后，同一回合的工具仍操作旧目录

**优先级：P1。**

主要位置：

- [worktree-tools.ts](../apps/cli/src/worktree-tools.ts)：`createWorktreeHost.enter`，第 87–90 行；按路径进入和退出也调用同一个 `setWorkspace`。
- [agent.ts](../packages/core/src/agent.ts)：调用 `agentLoop` 时，第 259 行取得 system prompt，第 274 行取得 `toolContext`。
- [ports.ts](../packages/agent/src/ports.ts)：`createToolHost`。
- [context.ts](../apps/cli/src/context.ts)：`checkPermission` 与 `dispatch`。

### 原因与影响

原来的斜杠命令在模型回合之外切换工作区。改为工具后，`setWorkspace` 会在正在运行的 agent loop 中执行，而 `runTurn` 已在回合开始时取得并固定了 `toolContext.cwd` 和 system prompt。

切换更新了 `ctx.workspace`、权限根和会话元数据，但当前 loop 后续调用仍使用旧的工具上下文；system prompt 也要到下一次进入回合时才重新取得。工作区 epoch 的变化不会主动更新已经传给 loop 的字符串。

因此，权限检查按新工作区解释相对路径，实际文件工具和默认 cwd 的 bash 却仍按旧工作区执行。即使 `enterWorktree` 已返回成功，后续操作仍可能落到主检出，违背隔离任务的目的。

### 复现

使用真实临时仓库、真实 `createContext` 和 agent loop，仅将模型替换为固定输出的模拟客户端。OS sandbox 关闭；显式允许 worktree 工具和 bash，文件写入使用 auto 模式的工作区内授权。

从主检出 `/repo` 开始，在同一用户回合的连续模型响应中依次调用：

1. `enterWorktree({ name: "isolated", from: "HEAD" })`。
2. `write({ path: "review-marker.txt", content: "written after enter\n" })`。
3. `bash({ command: "pwd" })`。

实际结果，以下路径已归一化以省略临时目录前缀：

```text
ctx.workspace            = /repo/.nova/worktrees/isolated
session workspace        = /repo/.nova/worktrees/isolated
/repo/review-marker.txt   = 存在
worktree 内的同名文件     = 不存在
bash pwd                 = /repo
后续请求的 system 首行   = You are a coding agent at /repo. ...
```

该复现不依赖并发：每次模型响应只返回一个工具调用。写入新文件已经证明权限判断与实际执行目录分离。

### 修复建议与回归验证

在切换成功后刷新或重新进入 loop，使后续模型请求和工具执行取得一致的新工作区上下文。仅修改 `ctx.workspace` 或 prompt epoch 不足以解决问题。

增加经过真实 agent loop 的集成测试：

- 同一回合先进入 worktree，再用相对路径 read/write 和未指定 cwd 的 bash，检查实际目标目录。
- 从 worktree 调用 `exitWorktree` 后继续操作，验证回到主检出。
- 检查切换后的 system prompt、权限根与实际执行目录一致。
- 同时覆盖默认关闭和启用 OS sandbox 的情况；本轮未执行 OS sandbox 集成验证。

## WTT02：并发切换导致工作区、权限和持久化绑定不一致

**优先级：P2。**

主要位置：

- [worktree/index.ts](../packages/tools/src/worktree/index.ts)：`createEnterWorktreeTool`，第 172–175 行；`createExitWorktreeTool` 同样缺少切换协调。
- [context.ts](../apps/cli/src/context.ts)：`setWorkspace`。
- [loop.ts](../packages/core/src/loop.ts)：第 376 行起的 `settleWithConcurrency`。

### 原因与影响

新工具作为普通工具注册，默认 `toolConcurrency` 为 3，没有对工作区切换设置独占约束。同一模型响应中的两个切换调用可以同时执行。

`setWorkspace` 先修改 `ctx.workspace` / `ctx.worktree`，随后经过多次异步操作重载 memory、重建权限和 sandbox、更新 LSP，并写入 session 元数据。两个调用交错时，各步骤可能属于不同的目标目录，最终状态没有一致性保证。

仅禁止子 agent 调用这些工具无法解决主 agent 同一批工具之间的竞争。

### 复现

预先创建同一仓库的 worktree A 和 B，让真实 agent loop 在同一模型响应中返回两个 `enterWorktree({ path })` 调用。

为稳定复现，测试通过异步屏障控制调度：A 在内存重载阶段暂停；B 完成切换后，A 再继续完成。这是对异步时序的控制，不是修改生产实现。

实际结果：

```text
toolConcurrency           = 3
ctx.workspace             = B
ctx.worktree.path         = B
session.json 的 workspace = A
读取 B 内 README.md       = 不再自动授权，转入权限提示
```

当前界面所在目录与恢复会话使用的目录不同，权限根也与当前工作区错位。

### 修复建议与回归验证

将工作区切换作为会话级独占操作，保证切换过程完整执行后才允许另一切换开始；同时协调切换与其他工具的执行。

不能只依赖模型按顺序调用，也不能仅为两个切换工具增加互斥后就假定所有问题消失：loop 在执行整批工具前已完成权限检查，普通工具与切换混在一批时，仍需保证授权和执行使用同一版本的工作区。

增加确定性的并发测试，覆盖：

- 两个 `enterWorktree`。
- `enterWorktree` 与 `exitWorktree`。
- 切换与普通文件工具混合调用。
- 完成后 workspace、worktree binding、权限根及 session 元数据一致。

## WTT03：新增工具遗漏 plan 模式的只读限制

**优先级：P2。**

主要位置：

- [context.ts](../apps/cli/src/context.ts)：第 781–786 行注册 worktree 工具。
- [permissions.ts](../apps/cli/src/permissions.ts)：第 30 行的 `MODE_MUTATING_TOOLS` 及 `resolveModeDecision`。

### 原因与影响

plan 模式通过 `MODE_MUTATING_TOOLS` 对变更工具实施硬拒绝。目前该集合只有 `write`、`edit`、`bash`、`monitor`，没有新注册的 `enterWorktree`。

因此，调用会继续走普通权限规则。如果存在该工具的 allow 规则或会话授权，plan 模式仍可创建分支、检出文件并迁移会话，而无需退出只读模式。

这不是“默认配置下所有调用都会自动放行”：复现条件是普通权限允许该工具，但 plan 模式应当继续阻止其创建工作区的副作用。

### 复现

1. 为 `enterWorktree` 配置普通 allow 规则。
2. 将当前权限模式设置为 `plan`。
3. 通过真实 `ctx.checkPermission` 检查 `enterWorktree({ name: "plan-proof", from: "HEAD" })`。
4. 根据授权结果执行真实工具。

实际结果：

```text
permission mode = plan
granted         = true
工具结果        = Entered worktree .../plan-proof
实际副作用      = 创建分支、创建检出并迁移会话
```

### 修复建议与回归验证

将具有创建副作用的 worktree 调用纳入 plan 模式的硬限制。如果产品希望允许在 plan 中切换已有检出，应明确区分“仅切换”和“创建”，分别定义权限。

通过真实权限入口增加回归测试，覆盖默认规则、显式 allow 和会话授权，确保普通授权不能绕过 plan 模式对创建行为的限制。

## 已执行的验证

相关测试全部通过：

```bash
pnpm vitest run \
  apps/cli/src/worktree-tools.test.ts \
  packages/tools/src/worktree/tools.test.ts \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/worktree-launch.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/launch.test.ts \
  apps/cli/src/session.test.ts \
  apps/cli/src/commands/rewind.test.ts

pnpm typecheck
```

结果：**9 个测试文件、152 项测试通过；类型检查通过。**

上述三个问题另以模拟模型或受控调度配合真实临时仓库复现，相关临时仓库已清理。现有测试主要覆盖工具 schema、host 调用和直接切换工作区，未覆盖本轮发现的 loop 内切换、并发切换及 plan 权限组合。

本轮未运行全量测试或 OS sandbox 集成测试；未修改实现代码，也未提交 Git commit。
