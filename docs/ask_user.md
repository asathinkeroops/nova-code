# ask_user 工具方案

## 目标

让模型在运行中主动向用户提问、等待用户作答后再继续，用于需求澄清、二选一决策、敏感操作确认等场景。与 `permission` 不同：`permission` 是工具调用前的拦截；`ask_user` 是模型主动发起的问询。

**核心特性**：一次调用支持 1–4 个并列问题，CLI 侧以多 tab 方式渲染，用户在 tab 间切换、逐个作答，最后一次性提交。这样模型可以在一个 turn 内把所有需要澄清的点问完，省 turn 也减少打断感。

## 工具定义

新文件 `packages/tools/src/builtin/ask-user.ts`，并在 `index.ts` 的 `builtinTools()` 中注册。

```ts
const optionSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
});

const questionSchema = z.object({
  question: z.string().min(1).max(500),
  header: z.string().min(1).max(12).describe("Short tab label, ≤12 chars."),
  options: z.array(optionSchema).min(2).max(4),
  multi_select: z.boolean().default(false),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});
```

工具名 `ask_user`。description 关键点：
- 一次最多 4 个问题，每题 2–4 个选项；
- “Other（自定义文本）”由 CLI 运行时自动追加，模型**不要**自己写 Other 选项；
- 仅当上下文无法推断、且确实需要用户决策时调用；不要每步都问。

## 返回格式

工具 output 是稳定的结构化文本，便于模型 parse：

```
[ask_user] answers:
- Q1 "<header1>": <label_a> | <label_b>
- Q2 "<header2>": Other → <用户自由文本>
- Q3 "<header3>": <label>
```

`is_error` 仅在用户取消（Ctrl+C / EOF）或环境无 UI（非 TTY）时为 true，内容写 `user cancelled` / `ask_user unavailable in this environment`。

## 架构：ToolContext 扩展

工具不直接读 stdin，由 CLI 注入能力，保留 headless 兼容性。

```ts
// packages/core/src/types.ts
export interface AskUserQuestionSpec {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}
export interface AskUserRequest {
  questions: AskUserQuestionSpec[];
}
export interface AskUserAnswer {
  selected: string[];       // 选中 option label（含 "Other"）
  freeform?: string;        // 仅当 selected 包含 "Other" 时存在
}
export interface AskUserResponse {
  answers: AskUserAnswer[]; // 与 questions 等长
  cancelled?: boolean;
}
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  askUser?: (req: AskUserRequest) => Promise<AskUserResponse>; // 新增
}
```

工具实现骨架：

```ts
async run(input, ctx) {
  if (!ctx.askUser) {
    return { output: "ask_user unavailable in this environment", isError: true };
  }
  const res = await ctx.askUser({ questions: input.questions.map(mapSpec) });
  if (res.cancelled) return { output: "user cancelled", isError: true };
  return { output: formatAnswers(input.questions, res.answers) };
}
```

## CLI 多 tab UI 草案

`apps/cli/src/ask.ts` 新模块，导出 `askUser(req)`。布局：

```
─────────────────────────────────────────────────────
│ ? 帮我确认几个点                                    │
─────────────────────────────────────────────────────
  ┌────────┐┌──────────┐┌──────────┐
  │ Align ●││ RowSep   ││ HeadBold │   tabs (●=当前)
  └────────┘└──────────┘└──────────┘
  ─────────────────────────────────────────────────
  Q: 表格整体边框？
  ❯ 1. 保留顶部和底部边框        当前 ┌┬┐ / └┴┘ 包围
    2. 去掉顶部和底部边框        看起来更轻
    3. Other (自定义)
  ─────────────────────────────────────────────────
  ←/→ 切 tab · ↑/↓ 选项 · space 多选 · enter 下一题 · ctrl+c 取消
```

- 三个状态指示：`✓` 已答 / `●` 当前 / 空 = 未答；
- 每个 tab 内部独立选项列表；多选用 `[x]` checkbox 呈现；
- “Other” 自动追加，选中 Other 时弹出输入框收集 freeform，复用 `readBoxedLine()`；
- 全部回答完毕后整体清屏，把结果折叠成一行 dim 摘要：
  ```
  ✓ ask_user · Align=保留… · RowSep=每行加横线 · HeadBold=加粗
  ```

实现要点：
- 复用 `apps/cli/src/input.ts` 的 raw-mode、stdin ref/unref、宽字符处理；
- 新增内部 `renderTabs()` / `renderQuestion()`，与 `renderMarkdown` 表格风格统一（使用 `│ ─ ┌┐└┘`）；
- 切 tab 用 `←/→` 或 `Tab/Shift+Tab`；
- `enter` 行为：若有下一题→跳到下一题；最后一题→提交全部；
- `esc` 关闭当前 Other 输入框，回到选项；连按两次 `esc` 取消整体（也响应 ctrl+c）；
- `ctx.signal` abort 时立即清屏 resolve `{ cancelled: true }`。

## 与 loop / dispatcher 关系

- ask_user 走标准 dispatcher：经过 `permission`、产生 `tool_use` / `tool_result` 事件、写入 transcript，无需特殊接线。
- permission 默认放行：在 `packages/safety` 默认 allow 列表中加入 `ask_user`，因为它不产生副作用（只是询问）。
- spinner：在 askUser 开始前调用现有 `stopSpinner()`，结束后无需重启（loop 自然会因下个 request 重启）。

## 非交互 / headless 行为

CLI 注入 askUser 时先判断 `process.stdin.isTTY`：

- TTY：正常多 tab UI；
- 非 TTY（pipe、CI、`--no-input`）：直接 resolve `{ answers: [], cancelled: true }`，工具返回 isError，模型据此自行决断。

## 边界 & 风险

1. **嵌套调用**：当前 loop 串行执行工具，单 ask_user 期间不会再来一个，无需处理。
2. **并发工具（未来）**：若 loop 支持并行工具，需要 ask_user 互斥锁——`apps/cli/src/ask.ts` 持有进程级 `inflight: Promise | null`。
3. **超长输入**：question ≤ 500 字符、label ≤ 60、header ≤ 12，schema 层 reject。
4. **模型滥用**：description 明确“不要为每个决策都问”；可在 system prompt 加补充说明（另案）。
5. **窗口缩放**：渲染逻辑要监听 `stdout.on("resize")` 重绘。
6. **Other 必为最后一项**：CLI 注入时统一在 options 末尾追加 `{ label: "Other" }`，模型自己写 Other 会被去重。

## 测试

`packages/tools/src/builtin/builtin.test.ts` 新增：

- ctx 无 `askUser` → isError；
- mock askUser 返回多题答案 → output 按格式拼接，每题一行；
- 含 Other + freeform → 输出包含 `Other → <text>`；
- mock 返回 cancelled → isError + 文案；
- schema 拒绝：questions=[]、questions 长度 5、单题 options=1、header 超长。

CLI 多 tab 交互暂不做自动化（需要 TTY mock），列入手动验证清单。

## 落地步骤

1. `packages/core/src/types.ts`：扩展 `ToolContext` 与导出 `AskUser*` 类型。
2. `packages/tools/src/builtin/ask-user.ts`：实现 ToolHandler + schema。
3. `packages/tools/src/index.ts`：注册到 `builtinTools()`。
4. `packages/safety`：默认放行 `ask_user`。
5. `apps/cli/src/ask.ts`：实现多 tab 渲染 + `askUser()` 函数。
6. `apps/cli/src/index.ts`：构造 ToolContext 时注入 `askUser`，TTY 检测。
7. 单测 + 文档串联。

## 显式不在范围

- 协议层把 ask_user 升级为 SDK 内置 stop_reason（保持纯工具方式，可移植）；
- 富 UI（图片预览 / HTML 表单 / preview 字段）；
- 跨会话记忆用户偏好（属于 memory 系统的事）。
