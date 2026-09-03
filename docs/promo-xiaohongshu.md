# 🚀 终端 AI 编程工具，我换成了 Nova——DeepSeek 用户狠狠心动

做开发的朋友应该都懂，终端里跑 AI agent 最在意三件事：**省 token、够安全、好扩展**。最近翻到一个开源项目 **Nova**——一个**为 DeepSeek 深度调优**的终端编程 agent，这三点全踩中了，必须来安利一波 ✨

> 📍 项目地址：<https://github.com/asathinkeroops/nova-code>
> 缓存友好 · 沙箱默开 · 零配置开箱即用 · TypeScript/Node 单仓多包

![Nova 终端界面](../snapshots/screen.png)

---

## 💰 亮点一：DeepSeek 一等公民，是真·原生适配

市面上很多工具只是"兼容" DeepSeek，Nova 是**从消息格式、缓存、错误处理到费用面板全链路吃透**了 DeepSeek 的 wire protocol 👇

- 🧠 **思考模式自动映射**：语义等级交给 provider profile 按协议转换，`/effort high` 一行搞定，不用碰 `reasoning_effort` / adaptive thinking 这些底层字段
- 🎯 **上下文缓存全自动命中**：消息历史严格 append-only，请求前缀逐字节稳定 → DeepSeek 服务端缓存每轮命中 → **响应更快、账单更省**
- 🩺 **错误码翻译 + 智能重试**：400/401/402/422/429/500/503 全附中文诊断，429/500/503 自动指数退避重试，不用退出 REPL 翻日志
- 📊 **实时费用可视化**：状态栏直连 `/user/balance` 显示账户余额，`/usage` 按 cache-read/write/uncached/output 拆账，缓存收益肉眼可见 💸

> 微压缩默认关闭也是刻意的性能决策——激进压缩会打断前缀、缓存重建成本反而更高。细节控会喜欢这个取舍 👌

---

## 🛡️ 亮点二：操作系统级命令沙箱，纵深防御

把 shell 交给 AI，最怕它写崩文件系统。Nova 直接上**内核级沙箱**，子进程写入被锁死在工作区内 🔒

- 🍎 macOS 用 Seatbelt，🐧 Linux 用 bubblewrap，系统原生方案，每次命令即建即销
- ⚡ **默认开启 + 静默降级**：支持的平台自动激活，不支持的悄悄跳过、不报错，**完全零配置**
- 🧱 **双层兜底**：权限引擎（`pre_tool_use`）可配置可干预，下层 OS 沙箱不可绕过，即使权限放行也兜底
- ✅ 预授权 `~/.npm`/`~/.pnpm`/`~/.cargo` 等缓存目录，`npm install` 照常跑
- ❌ `.ssh/`、`.git/hooks`、dotfiles 这类危险路径**强制拦截**，违规信息还会回灌给模型

---

## 🧩 亮点三：一个 `.md` 文件 = 一个新能力

扩展全靠 **Markdown + YAML frontmatter**，不改源码、不重新编译、甚至不用重启 REPL，还能提交进 Git 团队共享 📝

- 🤖 **子代理**：丢个 `.md` 到 `.nova/agents/`，立刻多一个带独立上下文的 reviewer / explorer，可并发启动
- ⌨️ **斜杠命令**：`.nova/commands/` 写模板，`/review main` 直接用，`$ARGUMENTS` 接参数
- 📚 **技能 Skills**：`SKILL.md` 启动注入索引、按需 `loadSkill` 拉全文，不白占上下文
- 🪝 **生命周期 Hook**（Claude Code 兼容）：8 种事件，stdin/stdout 走 JSON，shell 脚本就能做自动格式化 / 桌面通知 / 压缩前清缓存
- 🔌 **MCP 协议**：stdio/HTTP/SSE 外部工具一键接入，且走**完全相同的权限门**，不获任何特权

---

## 🎨 彩蛋：它的架构是真的优雅

Nova 的核心是**一个模型循环（agentLoop）+ 唯一扩展点 `HookRegistry`**。权限门控、上下文压缩、转录写入、UI 刷新全是 hook 挂上去的；`@nova/core` 本身不导入任何模型 SDK / 工具实现 / UI——纯粹的"无策略 agent 循环" 🤍

![Nova agent loop 与 hook 机制](./agent-loop.svg)

> ◆ 阻塞型 hook 能改写 / 否决某一步（首个非 undefined 生效），○ 通知型只观察、出错被吞不影响主流程。想加新能力？写个 hook 挂上去，循环源码一行都不用动 🔥

---

## 📌 一句话总结

| 亮点 | 工程上的实际收益 |
|---|---|
| 💰 DeepSeek 原生 | 缓存命中省钱、无需调参省心、出错即懂 |
| 🛡️ OS 级沙箱 | 零配置安全，`/etc/passwd` 写不进去 |
| 🧩 Markdown 扩展 | 不写代码也能定制 agent，随仓库共享 |

**省钱 + 安全 + 灵活**——正好对应选终端 AI 编程工具最在意的三个维度。DeepSeek 重度用户值得一试 🏃💨

⭐ 觉得有用就去 GitHub 点个 Star 支持作者～
👉 <https://github.com/asathinkeroops/nova-code>

---

#AI编程 #DeepSeek #程序员 #开源项目 #终端工具 #coding #AI工具 #效率工具 #后端开发 #github宝藏
