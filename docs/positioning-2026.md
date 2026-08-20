# Nova 产品定位重估（2026-08）

> **背景**：DeepSeek 于 2026-08-13 开源了官方 agent 运行时 **DeepSeek Harness（`dsh`）**，两天内 9.5 万星。Nova 原有的主标语「为 DeepSeek 量身打造的终端编程代理」被官方产品正面占位，必须重新定位。
>
> **结论先行**：被抢走的是**一句 slogan**，不是产品本身。`dsh` 占的是「agent 运行时框架」身位，Nova 占的是「终端编码成品」身位，两者受众不重叠。但 slogan 必须立刻换掉，否则 Nova 会被默认读成「官方 harness 的民间劣化版」。
>
> **文档性质**：战略定位判断 + 行动清单，不是实现方案。关于 Nova 与 Claude Code 的功能对比见 [`comparison.md`](./comparison.md)。

---

## 一、`dsh` 到底是什么

以下为 2026-08-18 依据公开报道整理，**未逐行核对 `dsh` 源码**，引用时请注意。

| 维度 | `dsh` 的实际形态 |
| --- | --- |
| 定位 | **框架，不是成品**。Cordis 微内核 + 「一切皆插件」，连 agent loop 本身都是可替换插件 |
| 界面 | 有 TUI 也有 Web UI（`npx @deepseek-ai/dsh web`，本地 `127.0.0.1:3080`），但官方定性为「搭在核心上的示例形态」；真正的界面是 YAML 配置 + TS 插件 |
| 成熟度 | `0.1.0-rc.5`，README 明写 `THERE WILL BE COMPATIBILITY-BREAKING CHANGES` |
| 模型绑定 | **不绑 DeepSeek**，~40 家 provider，子任务甚至能派给 claude-code / codex |
| 会话 | append-only 事件日志，支持 resume / fork / replay；可导入 Claude Code、opencode、Antigravity 的会话 |
| 沙箱 | Linux bwrap+Landlock / macOS Seatbelt / Windows 受限 ACL token |
| LSP | 未见集成 |

**已被指出的短板**：

1. **token 开销实测约为对手的 3~10×**（含一个已确认 bug：`.agents/` 与 `CLAUDE.md` 同步时重复注入 instruction）。
2. 两天涌入 2000+ 社区插件，真实可用率近乎为零，219 个集成被标记「需要关注」。
3. 插件跑在 harness 主进程内、具备文件系统与 shell 权限，信任模型目前靠「善意」。
4. 内部架构文档极厚（~17 万行），面向使用者的上手文档很薄。
5. 深度评测的原话：**日常写代码不推荐用它**，去用 Claude Code / Codex；它适合 agent 基础设施团队、多 agent 研究、需要可审计执行轨迹的组织；建议观望 3–6 个月。

### 对 Nova 的三条推论

- **空档仍在**。DeepSeek 抢走的是「agent 运行时」身位，不是「终端编码工具」身位。
- **顺风一处**。`dsh` 以 MIT 免费开源，亲手坐实了「模型收钱、harness 不该收钱」——Nova 不必再解释为什么白送。
- **软肋一处**。`dsh` 最疼的地方（token 开销）恰好是 Nova 架构上最强的地方，且这不是调参能追平的，见下节。

---

## 二、Nova 手里的实际筹码

规模基线（2026-08-18 实测）：`packages/*/src` 约 3.1 万行、`apps/cli/src` 约 3.6 万行，全仓 133 个测试文件。

按含金量排序，真正稀缺的是四样：

### 1. 缓存 / token 经济学是刻进架构的，不是调参

这是 Nova 最被低估的资产，也是唯一**结构性**、抄不走的差异。整条链路只服务一个目的——让服务端前缀缓存每轮命中：

- 历史严格 append-only（`packages/core/src/messages.ts`），`assertAppendOnly` 在 port 与 hook 两侧强制（`packages/core/src/ports.ts`）；
- 压缩只追加一条 `<compacted>` 边界、不重写历史，模型侧看到的是纯投影 `compactor.view(messages)`（`packages/agent/src/compactor.ts`）；
- `freezeSystemPrompt` 把 system prompt 在一个 session epoch 内焊死，provider 输出漂移即告警（`packages/core/src/agent.ts`）；
- 内部 `meta` 字段发送前剥除，不污染前缀（`packages/model/src/model.ts`）；
- 记忆与 skills 只在会话边界重建，`ctx.memory` 全仓仅一处可重新赋值。

**这些约束和 `dsh` 的极端插件化天然冲突**——一个可被任意插件改写的 loop，很难保证请求前缀逐字节稳定。这就是它 3~10× 开销的结构性来源。

### 2. 它是成品，不是乐高

`dsh` 没有或未成形，而 Nova 已经交付并有测试覆盖的：权限四档 + <kbd>shift</kbd>+<kbd>tab</kbd> 切换、OS 级写入沙箱（`packages/safety`）、read-before-edit + mtime 漂移防护（`packages/safety/src/invariants.ts`）、**LSP 代码智能**（`packages/lsp`，`dsh` 无）、MCP、Skills、三层记忆、可重放会话、`/doctor` 体检、headless + `--output-format json` 接 CI，以及 `cron` / `monitor` / `goal` / `predict` 这一整面自动化能力。

### 3. 中文母语 + 国产模型生态的产品细节

`settings.language`（模型回复语言）与 `settings.locale`（TUI 静态文案）分离；DeepSeek / Kimi 余额探针上状态栏（`ProviderProfile.probeBalance`）；HTTP 错误码翻成人话并附充值 / 建 key 链接（`packages/model/src/providers/deepseek.ts`）；CNY 计价（`packages/base/src/config/cost.ts`）。这是外国工具不会做、纯框架不屑于做的活。

### 4. Claude Code 迁移成本为零

slash 命令、快捷键、审批弹窗、记忆文件优先级（`NOVA.md` > `CLAUDE.md` > `AGENTS.md`）、**插件格式直接兼容**。`dsh` 只做到了 session 导入。

### 5. 关键事实：DeepSeek 耦合本身几乎不存在

真正 DeepSeek-only 的代码只有三处：`packages/model/src/providers/deepseek.ts`（错误码表 + effort 映射 + 余额探针）、`packages/base/src/config/models.ts` 里一张三档默认表、以及 CLI 侧一点品牌美术（`apps/cli/src/ui/deepseek-art*`）。

`ProviderProfile` 接口（`packages/model/src/providers/types.ts`）的注释本身就写着「加一个 provider = 加一个文件 + 注册表一行」。**换定位的工程代价远小于直觉。**

---

## 三、候选定位与取舍

| 方案 | 内容 | 判断 |
| --- | --- | --- |
| **A. 国产模型的 Claude Code** | 主打成品体验 + 中文母语 + 多国产 provider | 市场最大；但要求补齐 provider 覆盖，且需正面对上未来可能成熟的 `dsh` TUI |
| **B. 最省钱的终端编码代理** | 主打缓存命中率与 token 成本，拿 benchmark 说话 | 差异最锋利、最难抄（架构约束）；但受众偏窄，必须有数据支撑 |
| **C. 投靠 `dsh` 生态，做它的上层形态 / 插件包** | —— | **不推荐**。把 6.8 万行成品降级成别人 0.1 版本 API 的附庸，还要跟着 breaking change 跑 |

### 采纳：A 为骨，B 为刃

新定位一句话：

> **Nova —— 面向国产大模型的claude code。开箱即用的成品，不是拼装框架；同样的任务，token 花得最少。**

「成品 vs 框架」负责划清与 `dsh` 的边界，「token 最省」负责给出选它而非别的成品的理由。

---

## 四、行动清单（按优先级）

### P0 · 补 OpenAI-compatible 传输层 ✅ 已落地（2026-08-19）

**这是唯一的硬缺口，也是定位 A 能否立住的前提。**

现状：所有 provider 都经 `@anthropic-ai/sdk` 走 Anthropic 兼容协议（`packages/model/src/model.ts`），`ProviderProfile` 只抽象了 thinking 形状、错误码、余额探针、tokenizer 四件事，**没有抽象 transport**。而 Qwen / GLM / MiniMax / 豆包等国产主力是 OpenAI 协议优先。

需要在 `model.ts` 里引入第二条 transport 分支，并把 transport 选择提升为 profile 的一个字段。工作量集中在 `@nova/model` 一个包内，不触碰 loop 契约。

> **落地记录**：传输协议与供应商解耦——`settings.transport`（`"anthropic" | "openai"`）独立于 `provider`，DeepSeek 一个 profile 同时服务 `/anthropic` 与 `https://api.deepseek.com` 两个端点（thinking 旋钮随协议变化：`effort` 仅 Anthropic 端点有）；`openai.ts` OpenAI 兼容传输（官方 `openai` SDK 流式 `chat/completions`，`maxRetries: 0` 交回 Nova 自己的重试循环；请求体仍逐字节组装以保前缀缓存）+ `createModel` 统一工厂与共享重试循环。**不设通用 `openai` provider** —— OpenAI 兼容端点通过 `transport: "openai"` 在供应商自己的 profile 上使用。CLI 调用点仅改名，loop 契约未触碰。**未做**（另行确认）：Qwen / GLM / MiniMax / 豆包各自专用 profile 与 setup 模板——现有通用 `openai` 档配 `baseURL` 已可接入。

### P1 · 做一份公开的 token / 缓存 benchmark

同一批任务，对比 Nova vs `dsh` vs Claude Code 的**实际计费 token**。这是把方案 B 从话术变成武器的唯一方式，也正打在 `dsh` 当前最疼的地方。产出物应可复现——考虑复用 `eval/` 的 replay harness。

### P2 · 文案与定位改写

- 删掉「为 DeepSeek 量身打造」主标语（`README.md`、`README.en-US.md` 首屏 + 页脚、`docs/guide.md` 开篇）；
- 把 DeepSeek 从「唯一主角」降为「一等公民之一」；

> 注意：`docs/` 下的旧推广稿（`promo-*.md`、`core-highlights.md`、`agent-loop-xiaohongshu.md`）全部以旧 slogan 为核心，属于历史物料，不必逐篇改写，但新物料不应再沿用。

---

## 参考来源

- [Justin3go — DeepSeek Harness 深度评测](https://justin3go.com/en/posts/2026/08/15-deepseek-harness-review)
- [ChinaModelAPI — DeepSeek Harness v0.1 发布说明](https://chinamodelapi.com/news/deepseek-harness-v0-1-open-source)
- [MindStudio — What Is DeepSeek Harness?](https://www.mindstudio.ai/blog/deepseek-harness-agentic-coding)
- [Verdent — DeepSeek's Coding Plan: V4, Harness Team, and 2026 Roadmap](https://www.verdent.ai/guides/deepseek-coding-plan-2026)
