# Nova AI-native 架构审查

审查日期：2026-10-26。

**Nova 已经具备 AI-native 架构。作为交互式编程代理，内核基本够用；作为能长期自主执行、可靠验收的运行时，还存在明显缺口。** 当前最值得投入的是完成判定、能力边界和行为评估。

判断标准是：模型负责理解、规划、工具选择和反馈修正，确定性代码负责权限、状态、资源限制、恢复和验收。本次结论基于审查时的源码；源码位置后续可能变化，定位时以函数名为准。前三项是具体实现问题，后两项是面向架构成熟度的改进方向。

## 主要发现

### P1 任务完成判定可能误报

`/goal` 的 `parseVerdict()` 在没有匹配到明确 verdict 时，会把包含独立单词 `MET` 的普通文本判为成功；有多个 verdict 时，取第一次匹配。

直接执行当前实现，确认以下两个输入均返回 `met: true`：

```text
I cannot determine whether the goal is met.
```

```text
Example format: VERDICT: MET
Actual verdict: VERDICT: NOT_MET
Tests still fail.
```

成功判定随后会清除目标、停止继续执行。因此，含糊表述或对输出格式的引用，可能被当作任务已经完成。

验收代理只排除了 `createSubAgent`，仍拥有修改工具；“只验证、不修改”主要靠提示词约束。它仍经过父级权限门，但没有独立的验收能力边界。

源码依据：

- [goal.ts](../apps/cli/src/goal.ts)：`VERDICT_RE`、`parseVerdict`、`GOAL_EVAL_SYSTEM`。
- [goal-eval.ts](../apps/cli/src/goal-eval.ts)：`evaluateGoalWithAgent` 中的工具过滤与权限绑定。
- [repl.ts](../apps/cli/src/repl.ts)：`maybeContinueForGoal` 中成功后清除目标的路径。

建议采用经过 schema 校验的明确结论与证据引用，解析不确定时保持未完成；为验收代理配置独立能力集。任务完成应成为受验证的状态转换。回归用例应包含含糊表述、格式引用、互相矛盾的 verdict，以及验收代理尝试修改状态的情况。

### P1 只读权限依赖工具名黑名单

只读子代理排除的是 `write/edit/bash/monitor` 四个固定名称；plan 模式也采用类似规则。MCP 工具接入契约没有副作用分类，因此一个写入型 MCP 工具不会因“只读”自动被排除。

这类工具仍受父级权限检查，但父级许可不能保证子代理的只读承诺。例如，父会话已允许某个写入型 MCP 工具时，只读子代理的名称过滤本身不会阻止它使用该工具。

源码依据：

- [subagent.ts](../packages/agent/src/subagent.ts)：`MUTATING_TOOLS`、`childTools` 过滤、子代理 permission 包装。
- [permissions.ts](../apps/cli/src/permissions.ts)：`MODE_MUTATING_TOOLS`、`resolveModeDecision`。
- [tool.ts](../packages/mcp/src/tool.ts)：`McpToolDescriptor`、`mcpToolToHandler`。
- [types.ts](../packages/core/src/types.ts)：`ToolDefinition`。

建议在工具契约中表达读取、写入、执行、外部提交等效果及资源范围，由宿主确认权限分类；未知效果的扩展默认不进入只读能力集。不能仅信任外部工具自行声明的只读属性。新增工具应自动继承能力边界，避免每次接入都依赖人工补黑名单。

### P2 子代理模型独立但资源配置仍绑定主代理

子代理可以选择自己的模型，但共享父代理的 compactor；后者按主模型的窗口、输出预算和主会话开销计算压缩阈值。子代理的图片输入能力也从主模型读取。

当主模型窗口大于子代理模型时，子代理可能尚未触发压缩就已经超窗；主子模型模态不同时，读图行为也可能与子代理实际能力不一致。这是模型选择与运行资源配置没有一起隔离的问题。

源码依据：

- [session.ts](../packages/agent/src/session.ts)：`subAgentModelResolver`、`assembleSession` 中共享 compactor 的绑定。
- [context.ts](../apps/cli/src/context.ts)：`buildCompactor` 使用 `ctx.settings.model` 计算窗口和预算，子代理 `getSettings` 使用主模型解析 `modelModalities`。
- [subagent.ts](../packages/agent/src/subagent.ts)：子代理模型、配置和 compactor 的装配。

建议按每个代理实际选中的模型、提示词和工具集构建上下文预算与 compactor。共享策略和实现即可，实例配置需要独立。回归测试应覆盖主子模型窗口、模态和工具开销不同的组合。

### 行为评估闭环尚未建立

`eval/replay.ts` 当前是 0 字节。现有 AI-native 门禁检查 SDK 隔离、core 依赖、工具定义字段等静态规则；staged 模式还会对 AI-facing 改动没有配套测试文件给出提醒，但不验证这些测试是否覆盖实际行为。

这些机制有助于保护工程边界，尚不能验证任务成功率、压缩后的信息保真度、工具纠错能力或模型升级后的退化。现有运行时测试通过，也不足以证明真实任务质量稳定。

源码依据：

- [replay.ts](../eval/replay.ts)：空文件。
- [check-ai-native.mjs](../scripts/check-ai-native.mjs)：静态阻断规则与 `ai-surface-test` 提醒。
- [vitest.config.ts](../vitest.config.ts)：当前测试入口。

建议先建立小而稳定的任务集，覆盖：

- 修改代码并通过测试。
- 工具参数错误后的自纠正。
- 压缩后继续任务并保留关键约束。
- 权限拒绝后的行为。
- 不同模型的子代理协作。

记录完成率、错误完成率、耗时和成本，再接入持续回归。确定性 replay 用于验证机制和已知故障路径，真实模型任务评估用于衡量行为质量，两者都需要。

### 长期自治需要覆盖执行语义的恢复

当前工具批次结束后提交历史，能保证完整的消息配对。但若外部动作已经成功、进程在提交结果前崩溃，恢复后的历史无法可靠确认该动作是否完成。后台命令和 monitor 的管理状态也主要保存在内存 Map 中；输出日志落盘不等于执行管理状态已经恢复。

源码依据：

- [loop.ts](../packages/core/src/loop.ts)：工具批次完成后的 `history.commit`。
- [persistence.ts](../packages/agent/src/persistence.ts)：消息持久化与加载。
- [background/manager.ts](../packages/tools/src/background/manager.ts)：`BackgroundCommandManager` 的 `records`。
- [monitor/manager.ts](../packages/tools/src/monitor/manager.ts)：`MonitorManager` 的 `monitors`。

若要支持无人值守长任务，建议增加执行记录、可用时的幂等键，以及“结果未知”的核对机制。恢复时应先确认外部结果，再决定是否重试。当前恢复能力适合交互式会话，尚不足以承诺外部动作不会重复执行。

## 值得保留的架构基础

| 已有设计 | 判断 |
| --- | --- |
| 模型循环与 ports 分离，主代理和子代理复用内核 | 模型处于核心决策链路，机制实现通过明确接口接入 |
| 历史归档与模型上下文视图分离，system 按 epoch 冻结 | 对上下文容量、持久化和缓存有明确工程设计 |
| 输入校验、参数归一化、同文件串行执行、结果配对 | 确定性代码承担了模型动作的约束 |
| 权限、审批、中断、日志和恢复路径 | 已具备交互式代理产品所需的重要运行保障 |

相关实现：

- [loop.ts](../packages/core/src/loop.ts)：模型调用、工具调度和提交边界。
- [ports.ts](../packages/core/src/ports.ts)：端口契约、`freezeSystemPrompt`、`assertAppendOnly`。
- [compact.ts](../packages/agent/src/compact.ts)：`sliceFromLastCompacted` 与上下文预算。
- [dispatcher.ts](../packages/tools/src/dispatcher.ts)：校验、参数归一化、按资源串行执行。
- [assemble.ts](../packages/agent/src/assemble.ts)：将端口实现装配为统一的 `createAgent`。
- [agent.ts](../packages/core/src/agent.ts)：回合生命周期、中断与异常路径的历史救援。

## 改进顺序

1. 修复完成判定、扩展工具只读边界、子代理资源隔离三项正确性问题，并补充对应回归测试。
2. 建立任务级 eval 和可执行 replay，将真实失败样本纳入持续回归。
3. 根据无人值守长任务的实际需求，补齐执行记录、结果核对和恢复机制。

现有八包结构可以承载这些改进，无需为了 AI-native 重做分层。继续增加工具或代理类型，不能代替能力边界与行为评估。

## 验证范围

本轮审查未修改实现代码。验证结果：

- `node scripts/check-ai-native.mjs --all` 通过。
- 下列 10 个测试文件、198 项测试全部通过。
- 直接执行当前 `parseVerdict` 实现，复现了上述两种错误成功判定。
- 未运行全量测试或真实模型任务基准；现有测试通过不代表上述缺口已修复。

```bash
pnpm vitest run \
  packages/core/src/loop.test.ts \
  packages/core/src/ports.test.ts \
  packages/agent/src/agent.test.ts \
  packages/agent/src/compactor.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/subagent.test.ts \
  packages/tools/src/dispatcher.test.ts \
  packages/tools/src/dispatcher-concurrency.test.ts \
  apps/cli/src/goal.test.ts \
  apps/cli/src/permissions.test.ts
```

本文记录审查时点的架构状态，不改变 CLI、配置或工具行为，因此无需同步修改 README 和用户指南。
