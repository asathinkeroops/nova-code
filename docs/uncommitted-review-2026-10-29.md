# 本地未提交改动审查

审查日期：2026-10-29。

范围：本地已暂存、未暂存和未跟踪的改动，结合当前源码检查行为与回归风险。本次改动主要涉及技能索引从 system prompt 迁移到会话消息、技能刷新、子代理索引注入，以及 headless JSON 输出过滤。

**发现 3 个 P2 问题，均已通过最小复现确认。** 审查及本文归档未修改实现代码，也未修复下述问题。源码行号可能随后续修改变化，定位时以函数名为准。

## 1. P2 首次请求可能缺失技能索引

位置：[context.ts](../apps/cli/src/context.ts) 的 `makeSkillsIndexReminder` 注册处，审查时第 1352–1358 行。

技能索引钩子注册在计划模式提示和后台通知之后，而 `HookRegistry.runBlocking()` 遇到第一个非 `undefined` 返回值就停止执行。以 plan 模式启动时，计划模式钩子先返回消息，技能索引钩子不会在首次请求中执行。

最小复现按实际顺序注册 `makePlanModeReminder(() => "plan")` 和 `makeSkillsIndexReminder(provider)`，向钩子链传入用户消息和包含 `loadSkill` 的工具列表，结果为：

```json
{
  "firstRequestKinds": ["human", "plan-mode"],
  "hasSkillsIndex": false
}
```

索引已从 system prompt 移除，所以模型首次请求完全看不到可用技能列表。如果模型直接结束回答，就没有下一次请求来补上索引；不能将这种情况视为无害的延迟。后台或 monitor 通知抢先返回时也存在相同机制。

建议让必要的消息注入在同一次请求中组合完成，同时保持历史只追加的约束。仅调换注册顺序会把被跳过的问题转移给其他提示。回归测试应覆盖计划模式首次请求，以及通知与技能索引同时需要注入的情况。

相关源码：

- [hooks.ts](../packages/core/src/hooks.ts)：`HookRegistry.runBlocking`。
- [loop.ts](../packages/core/src/loop.ts)：`pre_request` 决策及模型调用。
- [plan-mode-reminder.ts](../apps/cli/src/plan-mode-reminder.ts)：`makePlanModeReminder`。
- [skills-index.ts](../apps/cli/src/skills-index.ts)：`makeSkillsIndexReminder`。

## 2. P2 会话切换未同步刷新技能快捷命令

位置：[session.ts](../apps/cli/src/session.ts) 的 `switchToSession`，审查时第 358–364 行。

会话切换调用 `ctx.skillsIndex.refresh()`，更新了扫描缓存、模型索引和 `/skills` 的列表，却没有重新注册技能快捷命令。命令注册表仍保留启动时的条目。

在临时工作区通过真实 `createContext` 和 `handleClear` 路径复现：

1. 创建名为 `alpha` 的技能并启动上下文。
2. 将技能 front matter 的名称和描述改为 `beta`。
3. 在已有会话消息的情况下执行 `/clear`。
4. 比较技能索引和命令注册表。

```json
{
  "before": {
    "index": ["alpha"],
    "commands": ["alpha"]
  },
  "afterClear": {
    "index": ["beta"],
    "commands": ["alpha"]
  }
}
```

结果是 `/skills` 已列出 `beta`，但 `/beta` 没有对应的技能展开命令；旧 `/alpha` 命令仍存在，调用时又无法从刷新后的缓存找到该技能。`/resume` 也经过同一个会话切换函数。

建议在会话边界刷新索引时同步调用技能命令重建逻辑，沿用启动工作区绑定和相同的扫描选项。回归测试应覆盖技能新增、删除、改名和可调用标记变化。

相关源码：

- [skills-index.ts](../apps/cli/src/skills-index.ts)：`SkillsIndexProvider.refresh`。
- [slash.ts](../apps/cli/src/slash.ts)：`loadSkillCommandsInto`、`reloadSkillCommands`。
- [commands.ts](../apps/cli/src/commands/commands.ts)：显式 `/commands reload` 已同时刷新索引和命令，可作为一致性参照。

## 3. P2 JSON 导出过滤掉了实际执行证据

位置：[headless.ts](../apps/cli/src/headless.ts) 的 `replayableMessages`，审查时第 61–64 行。

该函数过滤所有非 `compacted` 的 synthetic 消息。但 `synthetic` 表示消息由 Nova 注入，并不意味着内容只是内部提示：`monitor-notification` 是监控事件正文的唯一消息载体，事件并没有另一个对应的 `tool_result`。

最小复现通过真实 `makeMonitorNotifier` 生成包含 `build-42 finished with exit code 1` 的事件消息，再调用 `replayableMessages` 导出轨迹，结果为：

```json
{
  "modelContextIncludesEvent": true,
  "jsonTrajectoryIncludesEvent": false,
  "exportedKinds": ["user", "assistant"]
}
```

导出结果只剩用户请求和模型结论，缺少模型实际读取的事件。消费 `--output-format json` 的评估或回放程序无法仅凭该轨迹完整核验模型为何得出结论。保留 compaction 边界不能补回这些被删除的输入。

建议按具体消息类型区分内部提示与执行证据，保留承载执行结果的消息。回归测试应覆盖 monitor 事件，避免只验证技能索引、Todo 和计划模式提醒被过滤。

相关源码：

- [monitor/notifier.ts](../packages/tools/src/monitor/notifier.ts)：`renderEvents`、`makeMonitorNotifier`；事件正文通过注入消息交付。
- [headless.test.ts](../apps/cli/src/headless.test.ts)：现有过滤测试。

## 验证范围

- 相关 10 个测试文件、213 项测试通过。
- 类型检查通过：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`。
- 首次全量运行有 5 项颜色测试失败；执行环境为 `TERM=dumb`、`NO_COLOR=1`，会让颜色函数直接返回无 ANSI 转义的文本。标准终端环境下该文件的 10 项测试全部通过。
- 使用下列命令重新运行全量测试，**161 个测试文件、2298 项测试全部通过**：

```bash
env -u NO_COLOR TERM=xterm-256color pnpm vitest run
```

- 上述 3 个问题通过独立最小复现确认；现有测试通过不代表这些边界已有覆盖。
- `git diff --check` 通过。未运行真实模型任务基准。

本文仅记录审查结果，不改变 CLI、配置或工具行为，因此无需同步修改 README 和用户指南。
