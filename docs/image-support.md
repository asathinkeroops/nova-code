# 多模态 / 图片输入 —— 设计方案

> 目标：让 Nova 支持图片输入（贴报错截图、设计稿、UI bug 截图），覆盖日常 coding 高频场景。
> 定位约束：Nova "deeply tuned for DeepSeek"，而 DeepSeek 主力模型当前不支持视觉——因此**默认必须关**，做成 capability 探测，模型支持视觉才开放。

## 一、现状（已逐行核实）

| 环节 | 现状 | 文件 |
| --- | --- | --- |
| 内容块类型 | 联合只有 `text / tool_use / tool_result / thinking / redacted_thinking`，**无 image** | `core/src/types.ts:35-41` |
| tool_result 内容 | `content: string \| TextBlock[]`，**不含图片** | `types.ts:18` |
| 工具返回值 | `ToolRunResult = { output: string }`，**只能返回字符串** | `types.ts:181-184` |
| dispatcher | 硬编码 `content: result.output`（字符串） | `dispatcher.ts:82` |
| read 工具 | `readFile(abs, "utf8")`，纯文本，二进制会乱码 | `builtin/read.ts:51` |
| 模型适配层 | `messages as Anthropic.MessageParam[]` 直接透传给 SDK；**SDK 本身支持 image 块** | `model.ts:200` |
| 能力探测 | 只有 `detectThinkingFormat`（deepseek/anthropic），**无 vision 概念** | `model.ts:105` |
| 用户输入 | REPL 纯字符串；`@path` 自动补全已存在（72da975） | `apps/cli` |

**一句话结论**：底层 SDK 已支持视觉，缺口全在 Nova 自己的类型系统、工具返回通道、能力门控和输入层。

## 二、核心数据模型（无可绕开的地基）

新增 `imageBlockSchema`，对齐 Anthropic 线格式：

```jsonc
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "<b64>" } }
```

把它加入两处联合：

1. `contentBlockSchema`（用户消息能带图）；
2. `toolResultBlockSchema.content` 的数组分支（工具能返回图）。

这是唯一**必须先做、且会被其它所有部分依赖**的改动。注意 `noUncheckedIndexedAccess`、discriminated union 用 `"image"` 作判别键。

## 三、关键决策点 + 取舍

### 决策 A：工具返回通道怎么改

`read` 要能吐出图片块，但 `ToolRunResult` 现在只有 `output: string`，dispatcher 也写死字符串。

- **方案 A1（推荐）**：给 `ToolRunResult` 加可选 `blocks?: (TextBlock|ImageBlock)[]`；dispatcher 有 `blocks` 就用它，否则退回 `output`。**完全向后兼容**，现存所有工具一行不改。
- 方案 A2：把 `output` 改成 `string | blocks` 联合。改动面波及每个工具的类型，得不偿失。

→ **A1**。

### 决策 B：能力门控放哪（DeepSeek 定位的核心矛盾）

DeepSeek 主力模型无视觉，"deeply tuned for DeepSeek" 决定了**默认必须关**。

- 真值来源：`settings.vision.enabled` **默认 false**，显式开启。可叠加一个按模型名的启发式默认，但配置开关是权威。
- 门控落点：把 `capabilities?: { vision: boolean }` 塞进 `ToolContext`（纯 bool，core 保持模型无关）。这样：
  - read 读到图片但 vision 关 → 返回**清晰文字报错**（而不是塞一坨没用的 base64 进上下文）；
  - 输入层用户贴图但 vision 关 → 立即提示；
  - model 适配层做最后兜底，vision 关却混入 image 块时 strip 或报错。

→ 配置开关 + ToolContext 透传 bool，三处一致门控。

### 决策 C：图片来源 & 输入入口

两个独立入口，价值/成本差别很大：

- **C1 文件引用（推荐先做）**：复用已有的 `@path` 补全。输入里 `@shot.png` → 按 magic bytes 嗅探 mime → 转 image 块 → 构造**多块 user 消息**（需要 `messages.ts` 加 `userContent(blocks)` 构造器，替代纯 `userText`）。截图存到磁盘、拖拽路径的场景**第一天就可用**，零终端黑科技。
- **C2 OS 剪贴板贴图**：Ctrl-V 检测 → shell 调 `pngpaste`（mac）/`wl-paste`（Linux）。最贴合"直接贴截图"的高频需求，但**平台相关、最脆弱**，终端对二进制粘贴支持参差。

→ **Phase 1 只做 C1，Phase 2 再做 C2**。C1 已覆盖约 80% 价值。

### 决策 D：尺寸 / 缩放

base64 膨胀 ~33%，Anthropic 单图约 5MB / 8000px 上限。

- **方案 D1（推荐）**：配置 `maxBytes`，超限**直接拒绝并明确提示**。零依赖。
- 方案 D2：用 `sharp` 自动缩放。体验更好，但引入**原生依赖** + 构建复杂度。

→ **D1 起步**，缩放留作后续。

## 四、次要但要表态的点

- **持久化膨胀**：base64 会进 `messages.jsonl` / `transcript.jsonl`。v1 内联（自包含、可回放），接受体积；后续可外置到 session blob 目录 + 引用。先内联。
- **压缩（compaction）**：图片块无法文本摘要，老图应在压缩时优先丢弃——`pre_compact` 钩子需感知 image 块。Phase 1 可暂不处理，但要记一笔。
- **UI 渲染**：终端显示用占位符 `[image: shot.png 1024×768]`；iTerm/kitty 内联图协议是可选锦上添花，不进 v1。
- **配置**：`config.ts` 加 `vision: { enabled: false, maxBytes, formats }`，插在 `thinking` 之后。

## 五、Phase 1 TODO（地基 + 文件引用）

- [ ] `core/src/types.ts`：新增 `imageBlockSchema`，并入 `contentBlockSchema` 与 `toolResultBlockSchema.content` 数组分支；导出 `ImageBlock` 类型。
- [ ] `core/src/types.ts`：`ToolRunResult` 加可选 `blocks?: (TextBlock|ImageBlock)[]`（决策 A1）。
- [ ] `core/src/types.ts`：`ToolContext` 加 `capabilities?: { vision: boolean }`（决策 B）。
- [ ] `tools/src/dispatcher.ts`：有 `result.blocks` 时用它构造 `tool_result.content`，否则退回 `result.output`。
- [ ] `tools/src/builtin/read.ts`：按 magic bytes 嗅探 mime；图片走 base64 → 返回 image 块；`vision` 关时返回清晰文字报错；超 `maxBytes` 拒绝（决策 D1）。
- [ ] `runtime/src/config.ts`：新增 `vision: { enabled: false, maxBytes, formats }` schema（默认关），插在 `thinking` 之后。
- [ ] `core/src/messages.ts`：新增 `userContent(blocks)` 构造器。
- [ ] `apps/cli`：`@path` 引用图片文件时，嗅探 mime 并构造多块 user 消息（决策 C1）；vision 关时即时提示。
- [ ] `core/src/model.ts`：vision 关却混入 image 块时 strip/报错兜底；CLI 据模型 + 配置注入 `capabilities.vision`。
- [ ] UI：image 块渲染为占位符 `[image: name WxH]`。
- [ ] 测试贴源：`types` / `read` / `dispatcher` / `config`（及 `@path` 图片展开）。

## 六、Phase 2 TODO（增强）

- [ ] OS 剪贴板贴图（C2）：Ctrl-V 检测 → `pngpaste`（mac）/`wl-paste`（Linux）→ image 块；不可用时优雅降级。
- [ ] 自动缩放（D2）：引入 `sharp`，超限自动降分辨率/压缩而非直接拒绝。
- [ ] 压缩感知图片：`pre_compact` 钩子在压缩时优先丢弃老 image 块。
- [ ] 持久化外置：base64 落到 session blob 目录 + 消息内存引用，发送前 rehydrate，瘦身 `messages.jsonl` / `transcript.jsonl`。
- [ ] 终端内联渲染：iTerm2 inline images / kitty graphics protocol（能力探测后启用）。
- [ ] 按模型名的 vision 启发式默认，减少手动开关。
