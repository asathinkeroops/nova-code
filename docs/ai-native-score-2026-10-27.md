# Nova AI-native 评分（2026-10-27）

> 依据 [`docs/ai-native-architecture.md`](./ai-native-architecture.md) 的 **4 层、14 个维度、0–5 分、总分 70** 标准。
> 本文只做评分与差距记录，不修改实现。上一轮实现审查见 [`ai-native-review-2026-10-26.md`](./ai-native-review-2026-10-26.md)。

## 结论

**总分：48 / 70，处于 47–70「较成熟的 AI-native 架构」的下沿。**

Nova 的内核确实是 AI-native 的：模型在 `plan → act → observe → retry` 主循环里，上下文有预算、压缩和缓存契约，工具调用有 schema、权限、沙箱和错误语义，状态可持久化、可恢复、可回退，扩展通过 port / hook / tool registry / MCP / 子 agent 组合进来。运行时和交互层的大部分维度可以给到 4 分。

但标准的 5 分要求「可度量、可回归、可持续改进」，而 Nova 恰好在这条线上缺了三块：**没有可运行的离线 eval、没有 CI、没有失败样本回流**。因此 14 个维度里没有 5 分；总分刚过「较成熟」的 47 分线，而不是稳固的 50+。

一句话：**内核成熟，工程闭环未完成。** 当前最值得投入的不是再加工具，而是把「行为质量」变成可重复的测量。

## 评分表

| 层  | #   | 维度           | 分数 | 主要证据                                                                                                                                                                                                         | 主要缺口                                                                                                                                                                  |
| --- | --- | -------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | 1   | 控制流位置     | 4    | `packages/core/src/loop.ts` 的 `agentLoop`：模型调用 → `stop-reason` 判定 → 工具分发 → 结果回灌；`loop.test.ts` 覆盖工具往返、`max_tokens` 续写、`maxTurns`、refusal                                             | 没有任务级成功率 / 行为评估；循环正确性有测试，但「模型是否把任务做完」没有度量                                                                                           |
| L1  | 2   | 上下文治理     | 4    | `compact.ts` 的输入预算 + 90% 阈值 + overhead；`compactor.ts` 追加 `<compacted>` 边界；`ports.ts` 的 `assertAppendOnly` / `freezeSystemPrompt`；磁盘保留全量历史，模型只看切片；compact/memory/overhead 均有测试 | token 估算仍是启发式；没有「压缩后关键约束是否保留」的 eval 或失败样本回归                                                                                                |
| L1  | 3   | 工具/能力契约  | 4    | `dispatcher.ts` 的 zod 校验、别名归一化、`is_error` 语义、`executionKey` 串行；`permission.ts` 的 allow/ask/deny；`sandbox.ts`；`invariants.ts` 的 read-before-edit / mtime 检查；`exclusive` 批次屏障           | MCP 工具没有副作用/效果分类，只读子 agent 仍靠固定工具名黑名单；`sandbox.enabled` 默认关闭；目标评估器仍能拿到修改类工具（只靠提示词约束）                                |
| L1  | 4   | 状态与可回放   | 4    | `messages.jsonl` + `transcript.jsonl`；`post_commit` 持久化边界；中断/异常路径救援；`/resume`；`/rewind` + `SnapshotStore`；`recordInjections` 镜像注入消息；persistence/transcript/session/rewind 测试          | `eval/replay.ts` 为空，没有确定性 replay；`bash` 的 rm/sed -i/重定向不进快照；后台命令与 monitor 的管理状态主要在内存在，崩溃后无法确认外部动作是否完成                   |
| L1  | 5   | 失败与不确定性 | 4    | `retry.ts` 的 10 次上限 + 指数退避 + `retry-after`；`model.ts` 的 malformed tool JSON / 瞬态网络错误重试；abort；`max_tokens` 续写上限；`fitCompletionTokens` 的上下文 clamp；工具失败隔离；失败路径仍持久化     | 没有 agent 层显式请求超时（依赖 SDK 默认 / 用户中断）；没有 provider 失败后的自动降级/切换；失败恢复没有 eval 覆盖                                                        |
| L2  | 6   | 模型抽象与路由 | 3    | 双 wire adapter（Anthropic 兼容 + OpenAI `chat/completions`）；`providers/` 注册表；`models.ts` 的档位/窗口/模态/pricing；`/model` 热切换；thinking 语义抽象；模型层测试                                         | 没有 fallback；没有成本/延迟路由；子 agent 共享父级 compactor，图片模态按主模型解析——子模型窗口/模态不同时预算与读图行为可能不一致                                        |
| L2  | 7   | 可观测性       | 3    | `transcript.jsonl` 的 18 类事件；`post_request` 的 usage / `durationMs` / `stopReason`；`/usage` 分桶成本；状态栏缓存命中率；`GlobalUsageLedger` 跨会话累计；provider 错误分类；usage 可从 transcript 恢复       | 没有 trace / correlation id 贯穿请求链路；没有聚合指标（按工具/错误/模型的统计）；transcript 是本地文件，不是可查询的观测系统                                             |
| L2  | 8   | 评估体系       | 1    | 只有空壳：`eval/replay.ts` 为空文件，`eval/cases/` 只有 `.gitkeep`；`check-ai-native.mjs` 的 `ai-surface-test` 只是 WARN；无 `.github/` CI；`package.json` 无 eval 脚本                                          | 没有离线 eval、场景集、replay harness、模型升级回归；2265 个单测验证的是代码正确性，不是模型行为质量                                                                      |
| L2  | 9   | 安全与治理     | 4    | `permission.ts` 的规则优先级、5 种模式、敏感路径黑名单；workspace 读写根；`worktree-guard.ts` 的隔离；子 agent 复用同一权限门；sandbox 集成测试；read-before-edit / mtime 检查                                   | `sandbox.enabled` 默认 false 且失败 fail-open；没有 prompt injection 的内容来源/污点追踪；没有独立审计日志（transcript 不等于不可篡改审计）；只读子 agent 的 MCP 边界缺口 |
| L3  | 10  | 人机协作       | 4    | 流式输出；`abort()` / Esc 中断；审批与 `pre_tool_use` 门；plan mode 是工具层硬限制；`/rewind` 文件回滚；`/context` 与工具进度可见；plan 拒绝反馈注入模型；plan 提醒以追加消息保持 prefix cache                   | 目标评估器在宽松权限模式下仍可改文件；`bash` 副作用不可回滚；缺少跨 REPL→agent→permission→tool 的端到端审批测试；人工反馈没有结构化沉淀                                   |
| L3  | 11  | 扩展与组合     | 4    | `ports.ts` 的 port 契约；`hooks.ts` 的 0..N 订阅；tool registry；MCP；子 agent；`ToolPromptSection`；`exclusive`；eslint + `check-ai-native` 强制依赖方向；子 agent 工具过滤与权限继承                           | MCP 没有效果分类，只读能力边界默认靠名称黑名单；扩展组合行为有 transcript，但没有按扩展/工具聚合的观测                                                                    |
| L4  | 12  | 成本与性能     | 4    | `cost.ts` 的四桶计价；`cacheHitRate`；`/usage`；跨会话 usage ledger；`outputReserveTokens`；压缩阈值；`fitCompletionTokens`；`post_request` 的耗时；子 agent token 并入父会话                                    | 没有自动成本/延迟路由或批处理；没有成本回归 eval；token 估算是启发式                                                                                                      |
| L4  | 13  | 数据飞轮       | 2    | transcript / messages 可机器读取并可恢复 usage；auto-memory 的 `MEMORY.md` 能跨会话沉淀；synthetic kind 有版本兼容迁移                                                                                           | 没有「真实失败 → eval case → 工具/prompt 改进」的路径；用户反馈不进入数据集；没有模型版本 A/B 归因                                                                        |
| L4  | 14  | 工程流程       | 3    | `.githooks/pre-commit` + `check-ai-native.mjs`；eslint `no-restricted-imports`；159 个测试文件 / 2265 个测试；typecheck/lint/format 脚本；模型表变更在版本控制内                                                 | 没有 CI；门禁只在本地且可 `--no-verify` 绕过；`ai-surface-test` 只检查「有没有 staged 测试」，不检查覆盖；无 eval；门禁脚本本身无测试                                     |

**合计：20（L1）+ 11（L2）+ 8（L3）+ 9（L4）= 48 / 70。**

## 分数解释

- **4 分不是「功能多」**：它表示约束已经被强制执行，并有自动化验证。L1 的循环、上下文、工具、持久化、失败路径都达到了这个水平。
- **没有 5 分**：5 分要求「度量与评估闭环」。Nova 有 usage/成本/缓存等度量，但没有任务级 eval，也没有根据失败样本持续修复退化的机制。
- **1 分给评估**：`eval/` 只有空壳，不能运行任何 case；`ai-surface-test` 只是「改了 AI 面代码要带测试」的提醒，不是行为评估。
- **2 分给数据飞轮而不是 1**：transcript/messages/auto-memory 的数据沉淀已经实现且可测，缺的是从数据到 eval 再到改进的回流，不是存储本身。
- **3 分给模型路由 / 可观测 / 工程流程**：抽象、埋点和测试都有，但 fallback、聚合指标、CI 这些「换场景仍稳定」的强制项缺失，所以停在「设计 + 测试」档，而不是「强制约束 + 自动化验证」档。

## 与 2026-10-26 审查的关系

### 已修复

- `/goal` 的成功判定已改为**行首、显式的 `VERDICT:` 行**：不再把散文里的 `MET`、引用的格式示例或矛盾的多个 verdict 判为成功；无明确 verdict 时默认 `NOT_MET`。`apps/cli/src/goal.ts` 的 `parseVerdict` 与 `goal.test.ts` 已覆盖这些回归。
- 这消除了上一轮 P1 中最直接的误报路径，但仍不改变「评估器能力边界」的问题（见下）。

### 仍未解决

1. **只读能力边界**：`packages/agent/src/subagent.ts` 的 `MUTATING_TOOLS` 仍是 `write/edit/bash/monitor` 的固定集合；MCP 工具没有效果分类。父会话已允许某个写入型 MCP 工具时，只读子 agent 的名称过滤本身不会阻止它。
2. **子 agent 资源隔离**：`packages/agent/src/session.ts` 仍把父级 `compactor` 传给子 agent；`apps/cli/src/context.ts` 的 `modelModalities` 仍按主模型解析。子模型窗口/模态不同时，压缩阈值和读图判断可能不一致。
3. **目标评估器的能力集**：`apps/cli/src/goal-eval.ts` 仍只排除 `createSubAgent`，保留 write/edit/bash 等修改工具；「只验证、不修改」主要靠 `GOAL_EVAL_SYSTEM` 提示词。默认权限模式下写入会询问，但 `auto` / `acceptEdits` 下可能直接改文件。
4. **请求超时**：模型调用没有 agent 层显式 timeout；挂起的流式请求只能靠用户中断或 SDK 默认值。
5. **回放与恢复**：`bash` 副作用不进 `SnapshotStore`；后台命令 / monitor 的 `records` / `monitors` 仍是内存 Map，崩溃后无法确认外部动作是否完成。
6. **评估与 CI**：`eval/replay.ts` 为空、`eval/cases` 无黄金 case、没有 `.github/` CI；`--strict` 不在 pre-commit 中启用。

## 最低三项与建议行动

| 优先级 | 维度                | 目标（可验证）                          | 具体动作                                                                                                                                                                            |
| ------ | ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 8 评估体系          | 先有 8–12 个稳定 case，再谈模型升级     | 建立 `eval/cases/`（改代码并通过测试、工具参数错误后自纠正、压缩后保留约束、权限拒绝、子 agent 协作）；实现可执行的 replay/任务 runner；记录完成率、错误完成率、耗时、成本；接入 CI |
| P0     | 14 工程流程         | 让门禁从「本地提醒」变成「合并前必过」  | 加 GitHub Actions：`typecheck` + `lint` + `vitest` + `ai-native:check --all --strict`；把 `ai-surface-test` 从 WARN 改为可配置阻断；给门禁脚本本身加测试                            |
| P1     | 13 数据飞轮         | 让一次真实失败在 10 分钟内变成一个 case | 增加 `nova eval capture`：从 `transcript.jsonl` / `messages.jsonl` 生成脱敏 case 骨架；把 `/goal` 失败、权限拒绝、工具重试、压缩后失败作为首批样本；建立 case 版本与模型版本归因    |
| P1     | 3 / 9 / 11 能力边界 | 让「只读」成为工具契约，而不是名称列表  | `ToolDefinition` 增加 `effects` / `readOnly` / `resourceScope`；MCP 接入时由宿主确认分类，未知效果默认不进入只读集合；目标评估器改用独立只读能力集                                  |
| P2     | 6 模型路由          | 换模型/换场景不靠人工补配置             | 补 provider 失败 fallback（可配置、可观测）；子 agent 用自己的模型窗口/模态构建 compactor 与 settings；加「主子模型窗口/模态不同」的回归                                            |
| P2     | 5 / 4 恢复语义      | 长任务崩溃后能判断「做没做」            | 增加请求级 timeout；为有副作用的外部动作记录执行意图/幂等键；恢复时先核对再重试；把后台/monitor 管理状态持久化                                                                      |
| P3     | 7 可观测性          | 从「能翻日志」到「能聚合定位」          | 给 transcript 记录加 trace/request id；按工具/模型/错误类型聚合 token、成本、耗时、重试；保留本地优先，不强行引入 OTEL                                                              |

## 评分敏感性

48 分是下沿分数，不是稳固的 50+：

- 若把「沙箱默认关闭 + 无 prompt injection 防护 + 无独立审计」按更严格口径计入，维度 9 可降至 3，总分 47。
- 若把「目标评估器可修改文件」视为能力契约的实质缺口，维度 3 也可降至 3，总分 46–47。
- 反过来，若只看运行时架构（L1 + L3），Nova 已经接近 4 分档的上沿；拖低总分的是 L2 的评估/可观测和 L4 的飞轮/流程，而不是核心循环。

因此建议把 48 理解为：**架构已经是 AI-native，但「可持续改进」还没有成为工程事实。** 下一次复评前，优先把 P0 两项做成可执行、可回归的闭环，而不是继续增加工具或扩展点。

## 验证范围

- `node scripts/check-ai-native.mjs --all` 通过。
- 全量 `pnpm vitest run`：**159 个测试文件、2265 个测试全部通过**。
- 本次审查未修改实现代码；测试通过只证明现有行为没有回归，不代表上述缺口已修复。
- 未运行真实模型任务基准；行为质量仍是本次评分中证据最弱的部分。
