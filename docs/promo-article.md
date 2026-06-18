# Nova：为 DeepSeek 而生的终端编程智能体

**一个真正懂 DeepSeek 的终端 AI 编程助手 —— 读代码、写文件、跑命令，把任务从头推到尾。**

---

## 为什么是 Nova？

市面上的 AI 编程工具要么是 IDE 插件，要么是为 Anthropic/OpenAI 原生设计的 CLI。**Nova 是第一个为 DeepSeek 做了一等公民适配的终端编程智能体**。它不只是"兼容"DeepSeek —— 从消息格式、思考预算、上下文缓存到错误处理、定价面板，每一层都是按 DeepSeek 的特性调优的。开箱即用，不需要翻文档调 `cache_control`，不需要猜测 wire format，配好 API Key 就能跑。

---

## 五大核心亮点

### 1. 🧠 DeepSeek 深度调优，处处省心

- **思考模式原生映射**：DeepSeek 的 `output_config.effort` 自动根据预算匹配 —— `< 32k → high，≥ 32k → max`。`/effort` 一条命令随时切换，`-t off|low|medium|high|max` 命令行直达。
- **上下文缓存全自动**：消息历史是**只追加的**，从不原地修改 —— DeepSeek 服务端缓存持续命中，输入成本直降到缓读取价。微型压缩默认关闭（在 DeepSeek 上得不偿失），只在真正需要时才做一次前缀重置。
- **余额 & 费用实时可见**：状态栏显示当次会话的**估算花费**和 DeepSeek **账户余额**（直接调 `/user/balance`）。`/usage` 按 token 桶拆分明细 —— cache-read / cache-write / uncached / output 各自多少钱，一目了然。
- **错误码全翻译**：7 种 DeepSeek API 错误（400/401/402/422/429/500/503）被翻译成可读的中文错误提示并附修复建议，瞬态错误自动重试。

### 2. 🖥️ 全功能终端 TUI，不只一个黑框

Nova 不是"命令行参数 + 文本输出"的土炮工具。它是一个**完整的终端 REPL**，基于 Ink/React 构建：

- **实时流式输出**，鼠标滚动 & 文本选择
- **`@path` 模糊文件补全** —— 输入 `@` 弹出文件选择器
- **`!` shell 转义** —— 输入框变绿，直接跑本地命令，不走模型
- **Shift+Tab 切换权限模式**：`default` → `acceptEdits`（工作区内写入自动放行）→ `plan`（只读模式）
- **状态栏**：当前模型、花费、余额、token 用量、权限模式
- **下一步预测** placeholder（`/predict` 开关）

### 3. 🔒 操作系统级沙箱，默认开启

所有子进程工具（`bash`、长时间命令）都在 **OS 级沙箱**中运行 —— macOS 用 Seatbelt，Linux 用 bubblewrap。**文件系统写入被限制在工作区**内，读写权限和网络保持开放。这是基于 `@anthropic-ai/sandbox-runtime` 的纵深防御，叠加在权限引擎之上，而非替代它。

- 默认开启，不支持的平台**静默降级**，零配置。
- 常见包管理器缓存（npm/pnpm/cargo/go）预授权写入，开箱就能 `npm install`。
- `.git/hooks`、`.vscode/`、`.ssh/` 等危险路径**强制保护**。

### 4. 🧩 子智能体 + 自定义类型，一个 .md 搞定

模型可以通过 `createSubAgent` 把任务分派给**独立上下文的子智能体** — 它看不到父会话的内容，只返回最终报告。多个子智能体在同轮**并发执行**。

三种内置类型（`explore` · `plan` · `general-purpose`），但关键是**你可以用 Markdown 无限扩展**：

```markdown
---
name: reviewer
description: 只读代码审查，输出 file:line 格式的问题
tools: [read, grep, glob, lsp]
readOnly: true
model: deepseek-chat
maxTurns: 20
---

你是只读代码审查子智能体。逐文件审查 diff，按 file:line 格式报告问题……
```

把这个文件放到 `.nova/agents/reviewer.md`，它立刻变成一个可用的子智能体类型 —— `/agents` 可见、`/agent reviewer <任务>` 可调、模型自己的 `createSubAgent` 可选。

### 5. 🔗 Shell 钩子 × LSP 代码智能 × MCP 生态

- **Shell 钩子（Claude Code 兼容）**：在 8 个生命周期事件上跑自定义命令 —— `PreToolUse` 拦截工具调用，`PostToolUse` 自动格式化，`Stop` 发桌面通知。钩子从 stdin 收 JSON（`jq` 友好），stdout 输出 JSON 控制决策。**全局 → 项目 → 本地**三层叠加，项目级的 `.nova/hooks.json` 可以提交到仓库。
- **LSP 代码智能**：`lsp` 工具直连语言服务器（TypeScript / Python / Go / Rust），做**定义跳转、查找引用、hover 类型、诊断、符号搜索**。比 grep 精确得多 —— 它理解作用域和类型。
- **MCP 协议**：连接外部 MCP 服务器（stdio / http），桥接它们的工具到模型，受权限引擎管控。

---

## 技术底色

- **单一扩展点**：`@nova/core` 的循环只有一个 `HookRegistry`。权限、压缩、转录、UI —— 全是钩子。阻塞型钩子（`pre_*`）可以返回决策让循环服从；咨询型钩子（`post_*`）出错不炸。
- **严格的单向依赖**：`core` 绝不引入模型 SDK、工具实现或 UI。10 个包，依赖方向不可逆。
- **zod 边界**：工具输入、配置、跨包数据全部带 zod schema。工具输入校验失败的报错是**人话**（比如 `command is required (expected string)`），而不是糊一脸 zod issue。
- **append-only 历史**：消息历史只追加不修改 —— `messages.jsonl` 在磁盘上也是追加写入，只在真正分歧点才全量重写。这是缓存命中的前提，也是可回放审计的保证。
- **会话可恢复、可回退**：`--continue` 续接上次会话，`/rewind` 回退到任意历史点，`/compact` 手动压缩上下文。

---

## 快速上手

```bash
# 前置：Node ≥ 20，pnpm 10.28.2
git clone https://github.com/asathinkeroops/nova-code
cd nova-code
pnpm install
pnpm dev                    # 进入交互式 REPL，首次运行引导配置
pnpm dev "给这个函数加单测"   # 携带初始提示进入 REPL

# 无头模式
pnpm dev -p "解释这个项目结构" --output-format json
```

首次启动会引导你填写 API Key、选择模型，生成 `~/.nova/nova.config.json`。

---

## 一句话总结

**Nova 是你在终端里的 AI 编程搭档 —— 为 DeepSeek 而生，架构干净，安全默认，开箱即用。**

---

> GitHub: [github.com/asathinkeroops/nova-code](https://github.com/asathinkeroops/nova-code)
