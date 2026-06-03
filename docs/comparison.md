# Nova vs Claude Code

> 本文基于 Nova 仓库的**实际代码状态**整理,未实现的能力会明确标注,不夸大。

## 一句话定位

- **Claude Code** — Anthropic 官方出品,生态成熟(IDE 插件、桌面/Web 全平台),为 Claude 调校到极致的**成品**。
- **Nova** — **开源、可改、为 DeepSeek 量身定制**的终端编码代理。内核是一套干净的「无策略循环 + 单一钩子扩展点」**运行时范本**:既能开箱用,也能拆开当地基。

> 想要开箱即用的全家桶 → Claude Code;想要一个能跑 DeepSeek、还能自己改的内核 → Nova。

---

## 功能对比

| 能力 | Nova | Claude Code |
|------|:----:|:----:|
| 终端 REPL / 一次性 prompt | ✅ | ✅ |
| 文件读写 / 编辑、bash、glob / grep | ✅ | ✅ |
| Web 抓取 / 搜索 | ✅ | ✅ |
| 待办(todo) / 任务编排 | ✅ | ✅ |
| 子代理 + 只读角色隔离 | ✅ explore / plan / general-purpose | ✅ Task / subagent |
| 自定义斜杠命令(`.md`) | ✅(兼读 `.claude/commands`) | ✅ |
| 技能(SKILL.md 按需加载) | ✅ | ✅ |
| 分层记忆 | ✅ 三层 + 优先级择一 | ✅ CLAUDE.md 层级 |
| 上下文自动压缩 | ✅ 双层 micro + auto | ✅ |
| 权限规则引擎 | ✅ allow / deny / ask + 路径规范化 | ✅ |
| **OS 级命令沙箱** | ✅ 默认开(macOS Seatbelt / Linux bubblewrap) | ✅ |
| 实时流式输出 | ✅ 可开关 | ✅ |
| 会话恢复 / 回放 / 回退 | ✅ 双 JSONL + `/rewind` | ✅ |
| 扩展思考分档 | ✅ 5 档 | ✅ |
| **MCP 服务器** | ✅ stdio + HTTP,工具桥接 + 权限门控 | ✅ 成熟 |
| **LSP 代码智能** | ✅ 定义/引用/hover/诊断/符号(TS/Py/Go/Rust 自动识别) | ✅ |
| **DeepSeek 一等公民** | ✅ `effort` 自动适配 + 错误码诊断 | ❌ 主打 Claude |
| **钩子化无策略内核(可库化复用)** | ✅ | ⚠️ 闭源黑盒 |
| 用户级 shell 钩子(settings) | ❌ | ✅ |
| IDE 插件 / 桌面 / Web | ❌(vscode 仅占位) | ✅ 全平台 |
| 开源可改 | ✅ MIT | ❌ |

---

## Nova 当前支持的核心功能详解

### 🔧 内置工具
一线干活的工具集:`bash` · `read` · `write` · `edit` · `glob` · `grep` · `notebook-edit` · `webfetch` · `websearch` · `ask-user`(向用户反问) · `lsp`(语言服务器代码智能) · `todo`(待办清单) · `task`(任务流) · 长时命令(后台 `run` / `check`) · `load-skill`(按需拉取技能正文) · `createSubAgent`(派生子代理)。

### 🧬 子代理(Sub-agents)
通过 `createSubAgent` 工具派生子代理,三种角色:

- `general-purpose` — 全权,保留完整工具集;
- `explore` — 只读检索;
- `plan` — 只读规划(只产出方案,不落地实现)。

只读角色对写操作(`write` / `edit` / `bash`)做**工具层 + 权限层双重封锁**——查得了、改不了。

### 🪝 钩子化内核
`@nova/core` 是一个**与模型无关、本身无策略**的 Agent 循环,对外只暴露唯一扩展点 `HookRegistry`。权限、压缩、日志、UI、技能全部作为钩子挂入:

- **阻塞型钩子**(`pre_*`、`post_tool_use`)能返回循环必须遵守的决策,第一个非空返回值生效;
- **建议型钩子**(`post_*`)尽力而为,抛错被吞、不能改状态。

加新能力 = 挂个钩子,内核一行不动。

### 🔌 MCP 服务器
启动时接入 Model Context Protocol 服务器(`@nova/external`),支持 **stdio** 与 **HTTP** 两种传输。每个服务器的工具以 `mcp__<server>__<tool>` 命名空间桥接进工具注册表,走和内置工具一致的**权限引擎门控**(默认 `ask`)。连接失败的服务器只记日志并跳过,**绝不阻塞启动**;`/mcp` 查看服务器状态,`/mcp tools` 列出已桥接的工具。可按服务器或整体 `enabled: false` 关闭。

### 🔌 LSP 代码智能
`lsp` 工具(`@nova/lsp`)直连**语言服务器**(JSON-RPC over stdio),提供 `definition` / `references` / `hover` / `diagnostics` / `document_symbols` / `workspace_symbol` 六个 action——懂作用域和类型,比 grep 精确得多。**只读、默认放行**,语言服务器在首次调用时**懒启动**。内置自动识别 TypeScript / Python / Go / Rust(`typescript-language-server` / `pyright-langserver` / `gopls` / `rust-analyzer`),**Nova 不负责安装**——二进制需已在 PATH,缺失则静默降级为「未安装」提示。`/lsp` 查看各语言状态,`settings.lsp.servers` 可覆盖/扩展服务器表。

### 🛡 OS 级命令沙箱
**默认开启**的操作系统级沙箱(`@anthropic-ai/sandbox-runtime`),为派生子进程的工具(`bash`、长时命令)套一层平台沙箱——**macOS** 用 Seatbelt(`sandbox-exec`)、**Linux** 用 bubblewrap——把文件**写入**限制在工作区根目录(与权限引擎同一套允许根)加少量系统默认路径。读取保持开放、网络不受限,是叠在权限引擎之上的**纵深防御**而非替代品。不支持的平台(Windows)或缺依赖时**静默降级**为无沙箱,因此默认开也能安全发布;常见包管理器缓存(npm/pnpm/cargo/go…)已预置进可写白名单。`sandbox.enabled: false` 可整体关闭。

### 🧠 三层记忆
全局 → 用户 → 项目。每个目录内按 `NOVA.md > CLAUDE.md > AGENTS.md` 取最高优先级(**不合并**),文件名可配置。

### 📉 两层上下文压缩
`micro-compact`(轻量裁剪)+ `auto-compact`(逼近上下文阈值时摘要为单条消息),阈值 / 窗口百分比 / 摘要上限均可配。

### 🎚 五档思考预算
`off / low / medium / high / max`——给 DeepSeek 发 `output_config.effort`,给 Anthropic 发 `budget_tokens`,**按模型名自动切换线缆格式**(可手动覆写)。

### 🔐 权限引擎
`allow / deny / ask` 规则 + 通配匹配 + 运行时「永远允许」+ cwd 作用域只读豁免。工具路径在匹配前**规范化(realpath)**,避免软链 / 相对路径绕过;规则解析出错时降级为 `ask`(绝不静默放行)。

### 🩺 DeepSeek 错误码诊断
DeepSeek API 在线上与 Anthropic 兼容,失败会以 `APIError` 携带 HTTP `status` 抛出。Nova 把文档化的状态码(余额不足、鉴权失败、限流、服务端故障…)翻译成**可操作的中文指引**,并标注该错误**原样重试**是否可能成功,而不是丢出晦涩的 `"402 {…}"` 原始响应体。

### 💾 会话持久化 & 回退
`/resume`、`--continue` 恢复会话;`transcript.jsonl`(事件流)+ `messages.jsonl`(可重放历史),全程可回放;`/rewind` 回退到此前某条消息(其后的历史被丢弃)。

### ⚡ 斜杠命令 & 技能
内置 `/help` `/think` `/clear` `/compact` `/resume` `/rewind` `/plan` `/predict` `/commands` `/skills` `/mcp` `/lsp`(`/exit` `/quit` 退出);任意 `.nova/commands` 或 `.claude/commands` 下的 `.md` 自动注册为命令;`SKILL.md` 启动时扫描、按需加载。

### 🚀 体验
Ink/React 终端 REPL · 实时流式渲染(可 `stream.enabled` 开关)· 首次启动引导式配置(`~/.nova/nova.config.json`)· 有界工具并发(默认 3)· 下一句输入预测占位 · `ask-user` 多问卷反问(末尾固定一个 Submit / Cancel 确认页)。

---

## 选型建议

| 你的诉求 | 推荐 |
|----------|------|
| 开箱即用、要 IDE / 桌面 / Web 全平台 | **Claude Code** |
| 主力跑 DeepSeek,要为它调到最优 | **Nova** |
| 想读懂 / 改造 Agent 运行时本身 | **Nova**(开源 MIT) |
| 团队要可审计、可自托管的内核 | **Nova** |

---

> Nova 的价值不止「又一个 AI 编码工具」,而是一份关于「Agent 运行时该长什么样」的可读、可改范本。
> MIT 开源 · Node ≥ 20 · `pnpm dev` 即可起飞。
