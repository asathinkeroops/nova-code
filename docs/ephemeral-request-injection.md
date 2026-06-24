# TODO：请求尾部 ephemeral 注入通道

> **状态：未实现（设计提案）。** 本文记录一个尚未动工的 loop 原语，用于把「自动记忆召回」等动态上下文以接近 Claude Code system-reminder 的方式注入，而不破坏 nova 的 append-only 历史与 prompt 缓存。当前自动记忆走的是「启动快照 + system prompt 注入」，本提案是其后续演进方向，不阻塞现有功能。

## 背景与动机

自动记忆的索引（`MEMORY.md`）目前作为 `<memory layer="auto">` 注入 **system prompt**，在会话启动时由 `loadMemory` 加载一次（`apps/cli/src/context.ts`），此后整个会话是**快照**。这带来两个局限：

1. **本会话内不实时**：模型刚写进 `MEMORY.md` 的新记忆，要到下次启动新会话才进注入的索引。
2. **无法做相关性召回**：全量索引常驻，想按当前任务只注入相关记忆，就得每轮重建 system prompt——而 system prompt 在最前面，一改就**冲掉整个前缀缓存**。

Claude Code 的做法是把召回放进**消息流尾部的 `<system-reminder>`**：既能逐轮动态/相关性筛选，又因为在尾部而**不动 system prompt 前缀缓存**。

## 为什么不能直接「注入消息流」

nova 的消息流是**持久化的 append-only 历史**，这和 Claude Code 的 harness 托管、可重渲染的 system-reminder 语义不同。核对 `packages/core/src/loop.ts:130-151`，`pre_request` 能覆盖两类字段，性质相反：

| 覆盖字段 | 是否持久化 | 生命周期 |
|---|---|---|
| `messages` | **是**，写入 canonical 历史（`loop.ts:148-150`） | 永久、append-only、不可原地改 |
| `system` | **否**，仅本次请求（`loop.ts:144-146`） | 每轮重算、不入历史 |

因此：

- 若把记忆注入 **`messages`**，它永久进 append-only 历史。append-only 禁止替换，于是「每轮刷新相关记忆」只能不断**追加副本** → 重复堆积 / 在会话开头冻死成快照 / 污染可重放的 `messages.jsonl`。
- 若每轮重建 **`system`**，能动态，但改 system prompt 前缀 → **冲缓存**。

结论：**Claude Code 想要的「ephemeral 动态 + 尾部省缓存」在 nova 现有通道里都拿不到**——`system` 省不了缓存，`messages` 不是 ephemeral。需要一个新通道。

## 提案：ephemeral 尾部注入

给 loop 增加一个**挂在 request `messages` 尾部、但不写入 canonical `messages` 的瞬态内容**通道：

- **位置**：merge 进发给模型的 request 的 messages 尾部（在真实历史之后），渲染成一段 `<system-reminder>`。
- **不持久化**：不进 `messages`、不进 `messages.jsonl`、不参与 `persistMessages` 的前缀检查 → **天然不违反 append-only**，不污染 transcript。
- **每轮重渲染**：可做相关性筛选、可即时反映本会话内刚写的记忆。
- **缓存友好**：只动尾部，system prompt + 早期消息的长前缀缓存不受影响。

### 可能的接口形态（待定）

让 `pre_request` 的返回值支持一个新的 `ephemeralAppend` 字段（或新增专门的 hook 点），由 loop 在构造 `finalRequest` 时 merge 进 messages 尾部，但**不**走 `messages = override.messages` 的持久化分支：

```ts
// loop.ts，构造 finalRequest 时
const ephemeral = requestOverride?.ephemeralAppend ?? [];
const requestMessages = ephemeral.length ? [...messages, ...ephemeral] : messages;
// model.call 用 requestMessages；canonical `messages` 不变、不 append、不持久化
```

要点：
- `ephemeralAppend` **只**影响 `model.call` 的入参，绝不赋值回 `messages`。
- 与现有「`messages` override 持久化」分支互斥/正交，保持 append-only 不变量。
- 每轮由 hook 重新计算内容（如：读 `MEMORY.md` mtime → 变了才重渲染 / 按当前用户输入做相关性挑选）。

## 影响面（预估）

- `packages/core/src/loop.ts` — 新字段 merge 逻辑（核心，需小心不碰 append-only 与 tool_use/tool_result 配对不变量）。
- `packages/core/src/hooks.ts` — `pre_request` decision 类型扩展，或新 hook 点。
- `packages/agent` — 注册一个默认 hook，把自动记忆召回从 system prompt 迁到 ephemeral 尾部（或两者并存：静态 NOVA.md 留 system prompt，auto-memory 走 ephemeral）。
- 配置：是否启用 ephemeral 召回、相关性策略等，加到 `settings.memory`。

## 边界与注意

- **NOVA.md / 静态 memory 不迁移**：它稳定、永远相关，留在被缓存的 system prompt 最合适。只有 auto-memory 的「哪几条现在相关」才受益于动态召回。
- 务必保证 tool_use ↔ tool_result 配对不变量：ephemeral 内容只能是独立的提示性 user/system-reminder 文本，不得插入打断 tool 配对的结构。
- ephemeral 内容不计入持久历史 → 重放 / 压缩（compact）时不会出现，需确认这对 eval replay 无副作用。

## 不做什么

- 不把记忆写入 `messages` 流（持久化 append-only 会带来重复/冻结/污染，详见上文）。
- 不每轮重建整个 system prompt（冲前缀缓存）。
