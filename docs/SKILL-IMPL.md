# Skills 实现方案

> 范围：把 Anthropic / Claude Code 的 Skill（渐进披露的「知识载体 Tier 3」）能力落到 Nova。
> 状态：未实现。`packages/external/src/skills.ts` 是空文件占位。
> 设计原则：**doc 是"告诉模型怎么做"，skill 是"替模型做掉"**。SKILL.md 的描述（"何时该用"）进 system prompt 当索引；正文按需由模型显式调用 `loadSkill` 工具拉。

---

## 0. 目标与非目标

### 目标

1. 扫描磁盘上的 `SKILL.md`，构建紧凑索引注入 system prompt。
2. 提供 `loadSkill` 工具，模型按需取回 SKILL.md 正文。
3. 提供 `/skills` slash 命令，便于排查"为什么 X skill 没生效"。
4. 与现有 `slash` / `memory` / `dispatcher` / `permission` / `transcript` 体系保持一致：同样的层级合并语义、同样的可配置开关、同样的日志/转录可见性。

### 非目标（本期不做）

- **Skill 自动触发**：模型仍需显式 `loadSkill`。`triggers` 字段只作为索引行后面的 hint。
- **Skill-as-subagent**：把 skill 当成隔离子 loop 跑，是另一个独立 feature，单独排期。
- **每个 skill 单独的 permission rule**：未来可叠在 `permissions.rules` 上用 `skill:<name>` 形式，先不做。
- **Skill 远程分发 / 版本管理 / 签名**：纯本地文件。
- **Markdown 模板占位符 / 参数化 skill body**：slash 命令已经做了，skill 故意只回原文。

---

## 1. SKILL.md 规格

### 1.1 目录布局

每个 skill 是一个子目录，根目录必须有一个 `SKILL.md`：

```
<root>/
  code-reviewer/
    SKILL.md
    references/
      good.ts
      bad.ts
  migration-safety/
    SKILL.md
```

`<root>` 就是后面"扫描位置"里列出的几个目录。skill 的 `name` 来自 front-matter，不取自目录名（目录名只是排序方便）。

### 1.2 Front-matter

```yaml
---
name: code-reviewer            # 必填，kebab-case，全局唯一
description: Review a diff …   # 必填，单行，"何时该用"
triggers:                      # 可选，关键词数组，给模型一个 hint
  - review
  - diff
---
```

- `name`：`/^[a-z][a-z0-9-]*$/`，跟 slash 一致；非法 → 解析失败入 `errors`。
- `description`：≤ 200 字符，超了警告并截断。
- `triggers`：纯展示用，不参与匹配逻辑。
- 作者要附加参考文件就在 body 里写明路径，由模型用现成的 `Read` 工具去拿。`loadSkill` 只回 SKILL.md 正文。

### 1.3 Body

front-matter 之后的全部 Markdown，就是 SOP 正文。**不进 system prompt**，只在 `loadSkill` 调用时返回。

### 1.4 解析错误处理

解析失败不抛——记到 `SkillIndex.errors[]`，CLI 启动时 `logger.warn` 出来。**坏的 skill 不进索引、不阻塞其他 skill**。这点跟现有 slash loader 行为一致。

---

## 2. 扫描位置与优先级

```
project 层（项目优先）:
  {cwd}/.nova/skills/*/SKILL.md
  {cwd}/.claude/skills/*/SKILL.md

user 层:
  ~/.nova/skills/*/SKILL.md
  ~/.claude/skills/*/SKILL.md
```

规则与 slash 一致：

- **先发现胜**：扫描顺序固定为 project → user，project 内按上面列出的顺序。
- **同名冲突**：第一次出现的进 `accepted`，后续同名进它的 `source.shadowedBy[]`，供 `/skills` 排查。
- **不递归**：每个 `<root>` 下只看一级子目录。防止误吞 `node_modules` 之类的污染源。

---

## 3. 数据模型

`packages/tools/src/builtin/skills.ts` 只导出两个函数。内部状态（扫描、解析、冲突处理）全部封装；调用方不感知。

```ts
// packages/tools/src/builtin/skills.ts

export interface SkillListItem {
  name: string;
  description: string;
  triggers: string[];
}

export interface SkillsOptions {
  cwd?: string;            // 默认 process.cwd()
  home?: string;           // 默认 os.homedir()（测试注入）
  projectDirs?: string[];  // 覆盖默认 project root
  userPaths?: string[];    // 覆盖默认 user root
  extraDirs?: string[];    // 额外追加的 root
  logger?: { warn: (data, msg) => void };  // 解析失败 sink，默认 no-op
  /**
   * loadSkill 单次响应字节上限。被 `builtinTools` 在装配 loadSkill 工具时消费；
   * `getSkillList`/`getSkill` 自己不读。**不参与扫描 cache key**——
   * 改它不会强制重扫。默认 16384。
   */
  maxResponseBytes?: number;
}

/**
 * 扫描所有 root，返回去重后的 skill 列表。冲突按"先发现胜"，被遮蔽项静默丢弃。
 * 解析错误用 logger.warn 写出，不抛、不返回。
 * 同一进程内可被多次调用——内部按 (cwd, home, …opts) 做记忆化；
 * 调用方需要强制重扫时传不同的 opts 或重启进程。
 */
export function getSkillList(opts?: SkillsOptions): SkillListItem[];

/**
 * 取单个 skill 的 SKILL.md 正文（front-matter 之后）。找不到返回 undefined。
 * 不返回 location/source/errors——这些是实现细节。
 */
export function getSkill(
  input: { name: string },
  opts?: SkillsOptions,
): string | undefined;
```

设计上的取舍：

- **没有 `SkillIndex` / `Skill` / `SkillSource` 等中间类型对外**——调用方拿到的就是"列表"或"正文字符串"。
- **没有显式 reload**——记忆化按 opts 指纹缓存；要刷新就重启 CLI 或传新的 `extraDirs`。`/skills` 命令本身就直接调 `getSkillList()`，永远反映当前盘上状态（首次调用必然 miss，之后命中缓存）。
- **没有错误数组对外**——解析失败走 logger.warn，UI 想看就翻日志。这与 slash loader 的可见性一致（slash 错误也是 warn 出来）。
- **`getSkill` 不返回 location**——body 里出现的相对路径，渲染时由 loadSkill 工具自己补绝对路径前缀（见 §5）。
- **`maxResponseBytes` 寄居在 SkillsOptions 里**——严格说它是"loadSkill 工具的输出 cap"而不是扫描参数，但放一个统一的 config bag 比另开一个 ToolOptions 干净，调用方就一个对象走全程（CLI 装配传一次，slash 命令再读一次都是同一份）。代价是 `getSkillList`/`getSkill` 看到这个字段会忽略；为防止它意外影响 cache 命中，scan 的 cache key 只由 ResolvedOpts 五元组构成（`cwd/home/projectDirs/userPaths/extraDirs`），`maxResponseBytes` 与 `logger` 都不参与。

---

## 4. System prompt 注入

### 4.1 渲染格式

```
<available-skills>
- code-reviewer: Review a diff for correctness, regressions, and obvious smell
- migration-safety: Audit a SQL migration for lock duration and rollback risk
- (… 总字节超过 maxIndexBytes 时这里出现 "…N more skills truncated; raise settings.skills.maxIndexBytes to see all")
Use the `loadSkill` tool with `name` to read full instructions before acting.
</available-skills>
```

- 每行 `- <name>: <description>`，不带 `location`（路径污染缓存命中、对模型无价值，要看的话 `/skills` 自己看）。
- 排序：project 优先，然后 user，组内按 name 字典序。稳定 → cache 命中率高。
- 总字节超过 `settings.skills.maxIndexBytes`（默认 8 KiB）则尾部截断 + 加 hint 行。

### 4.2 接入点

`apps/cli/src/system-prompt.ts` 的 `buildSystemPrompt(workspace, memory, sessionId)` 加第 4 个参数 `skillsBlock: string`。CLI 装配处生成这个 block：

```ts
// apps/cli/src/context.ts 启动时
const skills = getSkillList({ cwd: workspace.root });
const skillsBlock = renderSkillsBlock(skills, settings.skills.maxIndexBytes);
```

`renderSkillsBlock` 是 apps/cli 里的 ~20 行小函数：空数组返回 `""`，否则 `lines.map(s => "- " + s.name + ": " + s.description)`，按 name 字典序排，超 cap 截断 + 加 hint 行，包 `<available-skills>` tag。**渲染逻辑不进 external 包**——`external` 只管"有哪些 skill"，怎么塞进 prompt 是 CLI 的事。

拼接顺序：

```
base prompt
↓
<available-skills> 块（如果有）
↓
memory.system
```

skill 块放在 memory 之前，让用户的 `NOVA.md` 等可以**指挥模型何时该用 skill**（用户写的 instruction 应该有更高的"信号权重"）。

---

## 5. `loadSkill` 工具

### 5.1 接口

```ts
// packages/tools/src/builtin/load-skill.ts

const inputSchema = z.object({
  name: z.string().min(1).describe("Skill name as shown in <available-skills>."),
});

export function createLoadSkillTool(
  getSkill: (input: { name: string }) => string | undefined,
  opts?: { maxResponseBytes?: number },  // default 16_384
): ToolHandler;
```

底层工厂 `createLoadSkillTool` 收一个**预绑定 cwd 的 getSkill 函数**——工具调用时只关心 `{ name }`，盘上文件、cwd、cache 全在闭包里。

实际装配走 `builtinTools(todoStore, skillsOpts?)`——传同一个 SkillsOptions，`builtinTools` 内部自己 `getSkillList(skillsOpts)` 判空、再 `getSkill(input, skillsOpts)` 构出闭包，自动注册 loadSkill 工具。`maxResponseBytes` 从 `skillsOpts.maxResponseBytes` 提取。CLI 只需要一个对象，不需要手动 bind。

reload 不需要重建工具：`getSkill` 内部记忆化按 opts 指纹查 cache，盘上文件没变就还命中。

工具描述（喂给模型的 description）：

```
Load the full instructions for a skill listed in <available-skills>. Call
this before acting on a task that matches a skill's description. Returns
the SKILL.md body; if the skill references supporting files, read those
with the Read tool. Read-only.
```

### 5.2 行为

1. **查找**：`const body = getSkill({ name: input.name })`；`undefined` → `isError: true`，输出 `"unknown skill: <name>. Use /skills to list available skills."`。
2. **字节 cap**：`body` 长度超 `maxResponseBytes`（默认 16 KiB ≈ 4k token） → 截断 + 末尾追加：
   ```
   …(truncated. SKILL.md body exceeds maxResponseBytes; raise settings.skills.maxResponseBytes or shorten the skill.)
   ```
3. **不动 fileLedger**：loadSkill 只读 SKILL.md 自身，不该影响 read-before-edit 不变量。

### 5.3 输出格式

```
<skill name="code-reviewer">
body 内容
</skill>
```

`getSkill` 不返回 location，输出里就不带 location；body 里如果出现相对路径，作者应该写明 skill 目录约定（例如 `references/good.ts`），模型用 Read 工具去拿。**保持 external 包的纯函数语义**——location 是实现细节。

### 5.4 注册时机

CLI 启动时根据 `getSkillList().length > 0` 决定是否注册 `loadSkillTool`——零 skill 时连工具都不暴露，省 system tools 字节、避免模型对一个空工具产生幻觉。

---

## 6. Slash 命令：`/skills`

仿照 `/commands` 的实现（`apps/cli/src/commands/commands.ts`），但只有列表一个子命令——`getSkillList()` 每次调都会读盘（命中缓存则极快），不需要单独的 reload。

- `/skills`：表格输出 `name | description`（triggers 拼一行追在 description 后做次要提示），按 name 字典序。
- **没有 reload**：盘上文件改了，重启 CLI；或临时改个 `extraDirs` 让 cache key 失效（这个开口是为 dev 留的，正常用户用不到）。本期不暴露 reload 子命令，让 API 表面尽可能小。

---

## 7. Settings schema

`packages/runtime/src/config.ts` 在 `slash` 旁边加：

```ts
skills: z
  .object({
    enabled: z.boolean().default(true),
    projectDirs: z.array(z.string().min(1)).optional(),
    userPaths: z.array(z.string().min(1)).optional(),
    extraDirs: z.array(z.string().min(1)).optional(),
    /** 注入 system prompt 的索引总字节上限。 */
    maxIndexBytes: z.number().int().positive().default(8_192),
    /** loadSkill 单次响应字节上限。 */
    maxResponseBytes: z.number().int().positive().default(16_384),
  })
  .default({ enabled: true, maxIndexBytes: 8_192, maxResponseBytes: 16_384 }),
```

默认开。`enabled: false` 时：不扫描、不注入索引、不注册工具、`/skills` 显示 "skills disabled in settings"。

---

## 8. 包结构与依赖

### 8.1 新增 / 修改的文件

```
packages/tools/src/builtin/
  skills.ts                [新] getSkillList / getSkill + 内部 scan / parse / cache
                                自带一个极简 front-matter parser（只认 name/description/triggers
                                三个字段），不复用 packages/external/src/slash.ts 里的版本——
                                slash 的 parser 处理 inputs/flags 等更复杂的形态，强行共用
                                得多走一层抽象，得不偿失。两份各几十行的小 parser 是可接受的。
  skills.test.ts           [新]
  load-skill.ts            [新] createLoadSkillTool(getSkill, opts)
  load-skill.test.ts       [新]

packages/tools/src/
  index.ts                 [改] export { getSkillList, getSkill, createLoadSkillTool,
                                  SkillListItem, SkillsOptions, SkillsLogger, GetSkillFn, … }
                                builtinTools 签名变成 `(todoStore, skills?: SkillsOptions)`——
                                不传或 getSkillList(skills) 为空时不注册 loadSkill 工具。
                                CLI 只传一份 SkillsOptions，工具的 getSkill 闭包和
                                maxResponseBytes cap 都由 builtinTools 内部从这份 opts 派生，
                                不需要外面手动 bind 或额外的 BuiltinToolsOptions 包装。

packages/external/src/
  (不动) slash.ts、index.ts 保持原状，front-matter parser 不外抽

packages/runtime/src/
  config.ts                [改] 加 settings.skills schema

apps/cli/src/
  system-prompt.ts         [改] 新增 skillsBlock 参数，拼到 base 与 memory 之间
  skills-render.ts         [新] renderSkillsBlock(items, maxBytes) → string
                                （仍放 CLI，因为渲染策略和 prompt 拼装强绑定，
                                  不该污染 tools 包的"工具实现"定位）
  context.ts               [改] 启动时构造一份 SkillsOptions（含 cwd / dirs / logger /
                                maxResponseBytes），调一次 getSkillList 出 items+渲染
                                skillsBlock，把同一份 SkillsOptions 透传给 builtinTools
  turn.ts                  [改] buildSystemPrompt 调用处传 skillsBlock
  slash.ts                 (不变)
  commands/skills.ts       [新] registerSkillsSlashCommand（从 @nova/tools 拿 getSkillList）
  commands/index.ts        [改] 调用上面的 register
```

### 8.2 依赖方向（与 CLAUDE.md 的不变量一致）

skills 整套都落在 `@nova/tools` 一个包内：

- `tools ──► core + runtime`（不变），不引入 `external`、不反向、不增 type-only 边。
- skill 数据 + 工具壳 + 内部 parser 同包同目录，绑定 cwd / 注入 getSkill 都在 `apps/cli` 装配。
- 之前讨论过的 `Skill`/`SkillIndex` 类型穿透、`@nova/tools` 反向依赖 `@nova/external` 的取舍，连同 `import type` 这条边，整个消失。
- `apps/cli/src/commands/skills.ts` 从 `@nova/tools` 直接 import `getSkillList`——CLI 依赖 tools 是允许的方向。

---

## 9. 转录 / 日志

- 启动时调一次 `getSkillList()`，写：`transcript.append({ kind: "skills_loaded", data: { count: list.length } })`，仿 `memory_loaded`。错误/scanned 详情都进 logger，不进 transcript（transcript 是给"会话回放"用的，加载噪音留在日志里）。
- 解析错误：`logger.warn({ path, err }, "skill parse failed")`，由 `skills.ts` 内部 catch 后写出。
- `loadSkill` 调用：走现有的 `tool_use` / `tool_result` 转录，无需特别埋点。

---

## 10. 测试计划（vitest，紧邻源码）

### `packages/tools/src/builtin/skills.test.ts`

- `getSkillList` 解析行为：
  - 合法 SKILL.md → 列表里有对应 item，三个字段齐全。
  - 缺 `name` / `description` → 不进列表，logger.warn 调用一次。
  - 非法 name（含大写、含空格）→ 不进列表，logger.warn。
  - `description` 超 200 字符 → 截断后进列表（不丢）。
  - `triggers` 缺省 → `item.triggers === []`。
- `getSkillList` 扫描行为：
  - project + user 都有 → 都进列表。
  - project 与 user 同名 → 只保留 project 那条（user 静默丢弃）。
  - 多个 project root 同名 → 第一个胜。
  - 不递归：`<root>/foo/bar/SKILL.md` 不被收。
  - 缺 SKILL.md 的子目录被静默跳过。
- `getSkill`：
  - 已知 name → 返回 body 字符串（front-matter 已剥离）。
  - 未知 name → 返回 `undefined`。
  - 同名冲突时，返回的是"先发现"那个的 body（与列表里展示的一致）。
- 记忆化：
  - 相同 opts 连续调用两次 → 第二次没有再触发 fs 读（用 spy 验证）。
  - opts.extraDirs 改变 → cache miss，重新扫。

### `packages/tools/src/builtin/load-skill.test.ts`（独立于 skills.test.ts，纯靠注入函数测）

- 未知 name（注入 `() => undefined`）→ `isError: true`，文案含 `/skills`。
- 已知 name（注入 `() => "body"`）→ 输出 `<skill name="…">body</skill>`。
- body 字节超 cap → 输出末尾含 truncation hint。
- 注入函数本身切换返回值 → 工具立刻看到新值（验证"不闭包 index"的契约）。

### `apps/cli/src/system-prompt.test.ts`（可能要新增）

- `skillsBlock === ""` → 输出不含 `<available-skills>` tag。
- 非空 → tag 内容、与 memory 的拼接顺序符合预期。

### `apps/cli/src/skills-render.test.ts`（新）

- 空 list → `""`。
- 单条 → 一行 + hint，包 tag。
- 总字节超 maxBytes → 末尾截断 + "…N more skills truncated"。
- 排序稳定：相同输入两次渲染字节相等（cache 友好）。

### 端到端 smoke（手工 / 可选脚本）

在 `examples/skills/code-reviewer/SKILL.md` 放一份示范 skill，跑 CLI：

1. 启动后 `/skills` 能看到。
2. 提示模型 "review this diff"，确认它会调用 `loadSkill`。
3. 没问到 skill 主题时，`tool_use` 历史里不应出现 `loadSkill`。

---

## 11. 实现顺序（建议小步快跑）

1. **skills.ts MVP**：`packages/tools/src/builtin/skills.ts` —— `getSkillList` + `getSkill` + 内部极简 front-matter parser + cache，配 `skills.test.ts`。
2. **settings**：加 `settings.skills` schema。
3. **CLI render + system prompt 注入**：`apps/cli/src/skills-render.ts` 加 `renderSkillsBlock`；`buildSystemPrompt` 加参数，CLI 装配处传入。先肉眼看 prompt 长什么样。
4. **`loadSkill` 工具**：`createLoadSkillTool(getSkill, opts)` + 测试。装配处把绑定 cwd 的 `getSkill` 透传给 `builtinTools`。
5. **`/skills` slash 命令**：只有 list，从 `@nova/tools` import `getSkillList`。
6. **示例 skill + 转录埋点 + 手工 smoke**。
7. **README 一段 + 在本项目根新建 `.nova/skills/` 自举一个 skill**（比如 `nova-test-runner: pnpm vitest run …`），dogfood 一遍。

每一步都能独立合并；1/3/4 之间的依赖是单向的。

---

## 12. 风险与对策

| 风险 | 对策 |
|------|------|
| 索引膨胀污染 system prompt / 打穿 cache | 硬 cap `maxIndexBytes` + 排序稳定（不按时间/调用频次重排） |
| 模型把 `loadSkill` 错认成"用户喊它做的工具" | 工具 description 明确说"only call when a skill in `<available-skills>` matches the task" |
| 用户在 `~/.nova/skills/` 放了几百个 skill | 默认硬 cap 在 `renderSkillsBlock` 就截断；`/skills` 仍能看到全部并提示 raise cap |
| 把 `node_modules` 之类的目录当成 skill root | 不递归 + 必须有 SKILL.md + name 合法 → 天然过滤 |
| 盘上 SKILL.md 改了但缓存没失效 | 接受这一点——重启 CLI 即新——换取 API 表面更小；如果痛了再加 `invalidate` 导出 |

---

## 13. 自举使用

实现完跑通后，建议在本仓库根上 `.nova/skills/` 放一些只对本项目有用的 skill，例如：

- `loop-contracts/SKILL.md`：CLAUDE.md 里 "Loop contracts" 那一段的展开版，body 解释 `tool_use/tool_result` 配对、`compactor` 引用相等约定、`observer` 错误吞掉的细节，给以后改 `packages/core/src/loop.ts` 的人用。
- `release-checklist/SKILL.md`：发版前要跑什么、要更新哪些文件。

这样可以验证两件事：（a）模型确实会在合适时机调 `loadSkill`；（b）"何时该用"的描述质量决定 skill 实际触发率，是日常维护重点。
