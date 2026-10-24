# Worktree 实现审查

最近复审日期：2026 年 10 月 25 日。[第五轮复审](#第五轮复审)确认 1 项 P1 回归（WT17）：共享路径规范化函数与文件工具的实际执行路径不一致，可能在检查获准后覆盖主检出文件。WT16 和 WT13 在第四轮描述的具体复现场景已修复。前四轮记录保留如下；各轮问题、优先级和修复状态对应当轮审查，最新结论以第五轮为准。

首轮审查日期：2026 年 10 月 24 日。

首轮审查针对工作区中尚未提交的 worktree 实现，覆盖创建与复用、会话切换与恢复、权限隔离、忽略文件复制，以及相关测试。当轮共确认 6 个问题：4 个 P1、2 个 P2。P1 涉及隔离、信任边界或文件安全，应优先处理；P2 涉及命令功能和路径一致性。

审查未修改实现代码。以下位置和行为对应审查时的源码；行号可能随后续修改变化，定位时以函数名为准。

## 首轮问题概览

| 编号 | 优先级 | 问题                                       | 主要位置                                         |
| ---- | ------ | ------------------------------------------ | ------------------------------------------------ |
| WT01 | P1     | 相对 cwd 的检查与执行使用不同基准目录      | `worktree-guard.ts` 的 `worktreeIsolationDenial` |
| WT02 | P1     | 恢复会话后未检查实际工作区的信任状态       | `context.ts` 的 `createContext`                  |
| WT03 | P1     | 复制忽略文件可能覆盖目标分支中的已跟踪文件 | `worktree.ts` 的 `copyIncludedFiles`             |
| WT04 | P1     | 换行后的 cd 漏过隔离检查                   | `worktree-guard.ts` 的 `cdTargets`               |
| WT05 | P2     | 文档中的 from 参数语法解析错误             | `commands/worktree.ts` 的 `handleWorktree`       |
| WT06 | P2     | 从 linked worktree 启动会创建嵌套检出      | `worktree.ts` 的 `addWorktree`                   |

WT01 和 WT04 的“放行”指 worktree 隔离检查没有拒绝调用，后续普通权限流程仍会执行。在普通权限允许命令、且 OS sandbox 未启用的情况下，命令可以作用于主检出；当前 sandbox 默认关闭。

## WT01 相对 cwd 的检查与执行使用不同基准目录

**优先级：P1。**

位置：[worktree-guard.ts](../apps/cli/src/worktree-guard.ts) 第 125–127 行；执行路径见 [bash.ts](../packages/tools/src/bash.ts) 的 `runBash` 第 206–216 行。

隔离检查通过 `isInsideMain` 将相对 `cwd` 按当前 `workspace` 解析，但 `runBash` 使用 `input.cwd ?? ctx.cwd`，将显式相对路径原样交给 execa。后者按 Node 进程的当前目录解释该路径。切换 worktree 只更新会话工作区，并未改变进程当前目录，因此两处判断不一致。

**复现步骤：**

1. 从主检出 `/repo` 启动进程。
2. 将会话切换到 `/repo/.nova/worktrees/first`。
3. 调用 bash 工具，输入如下：

```json
{
  "command": "pwd",
  "cwd": "."
}
```

临时仓库实测：隔离检查不拒绝，`pwd` 返回主检出，而非 worktree。若随后执行构建、文件写入或 Git 操作，就可能操作错误的检出。

**修复建议：**相对 `cwd` 应统一相对于会话工作区解析，并让权限检查与进程启动使用同一份规范化后的绝对路径。同步检查 bash 前台、后台及 monitor 分支，它们都接受显式 `cwd`。

**回归验证：**从主检出切入 worktree 后，分别传入未指定 `cwd`、`.`、子目录及绝对路径，验证权限判断与真实进程的 `pwd` 一致。

## WT02 恢复会话后未检查实际工作区的信任状态

**优先级：P1。**

位置：[context.ts](../apps/cli/src/context.ts) 第 205–210 行；相关调用见 [index.ts](../apps/cli/src/index.ts) 的 `runHeadlessMode`、`run`，以及 [session.ts](../apps/cli/src/session.ts) 的 `resolveSession`。

启动入口先对 `opts.cwd ?? process.cwd()` 执行信任检查，随后 `createContext` 调用 `resolveSession`。后者允许恢复到同一仓库的另一份检出，并将其作为实际 `workspace`。这个目标可能位于已信任根目录之外，但初始化前没有再次验证信任。

**复现步骤：**

1. 仅信任主检出 `/repo`。
2. 在 `/linked/external` 创建该仓库的 linked worktree，并保存绑定到它的会话。
3. 从 `/repo` 使用 `nova --resume <id>` 恢复该会话。

临时仓库验证得到：

```text
launchTrusted = true
resolvedTrusted = false
workspace = /linked/external
```

初始化会从恢复目标加载项目配置；交互模式的 `runRepl` 随后执行 `SessionStart` hooks。同属一个 Git 仓库，并不等于目标路径已经获得当前信任策略的授权。上述验证确认了信任状态与恢复目标的错位，未执行不可信 hooks。

**修复建议：**先确定最终会话工作区，再对该目录完成信任检查；检查通过后才能加载项目插件、hooks 等配置。交互模式和 headless 模式应共享这一顺序。

**回归验证：**只信任主检出时，恢复到仓库外部的未信任 worktree 应要求确认；headless 应拒绝。位于已信任根目录下的 worktree 应正常恢复。

## WT03 复制忽略文件可能覆盖目标分支中的已跟踪文件

**优先级：P1。**

位置：[worktree.ts](../apps/cli/src/worktree.ts) 的 `copyIncludedFiles` 第 355–370 行。

候选文件通过来源检出的 `git ls-files --others --ignored --exclude-standard` 筛选，但复制前没有检查目标检出的跟踪状态，也没有避免覆盖已有文件。来源当前被忽略的文件，在目标起点分支中可能仍然被跟踪。

**复现步骤：**

1. 提交一个被跟踪的 `config.local`，内容为默认配置，记下该提交。
2. 在后续提交中取消跟踪该文件，并将 `*.local` 加入 `.gitignore`。
3. 在来源检出创建本地 `config.local`，写入演示内容 `LOCAL_SECRET=demo`。
4. 在 `.worktreeinclude` 中加入 `*.local`。
5. 从第一步的旧提交创建 worktree，并启用包含文件复制。

临时仓库实测：复制数量为 1，新 worktree 的 `git status --porcelain` 显示：

```text
 M config.local
```

目标文件内容已变为来源的本地配置。除覆盖目标分支的文件外，真实密钥或其他本应被忽略的内容也可能进入后续提交。

**修复建议：**复制前检查目标检出的跟踪状态，跳过已跟踪文件及已存在的目标，并报告冲突。若要保证复制后仍为忽略文件，还应验证目标检出的忽略规则。

**回归验证：**覆盖来源忽略但目标跟踪、目标已存在、两端都忽略且目标不存在等情况；目标的已跟踪内容必须保持不变。

## WT04 换行后的 cd 漏过隔离检查

**优先级：P1。**

位置：[worktree-guard.ts](../apps/cli/src/worktree-guard.ts) 的 `cdTargets` 第 75–78 行。

当前正则识别字符串开头、部分连接符和控制流关键字后的 `cd`，但没有把换行视为命令边界，也没有启用多行匹配。因此普通多行 shell 脚本中的 `cd` 会漏检。

**复现输入：**会话工作区为 `/repo/.nova/worktrees/first`，bash 命令为：

```bash
echo ready
cd /repo && pwd
```

临时仓库实测：隔离检查不拒绝，实际 shell 输出第二行为主检出路径。把 `pwd` 换成修改工作目录或索引的命令，就会操作主检出。

**修复建议：**至少补齐换行边界，并系统检查所支持的 shell 语法，避免只修正单个样例后继续遗漏其他语句形式。解析出的路径还应使用实际命令执行目录作为基准。

**回归验证：**覆盖换行分隔、缩进后的 `cd`、带引号路径、控制流，以及正常留在 worktree 内的多行命令。

## WT05 文档中的 from 参数语法解析错误

**优先级：P2。**

位置：[commands/worktree.ts](../apps/cli/src/commands/worktree.ts) 的 `handleWorktree` 第 45–46 行，以及 `createAndEnter` 第 97–103 行。

命令说明提供 `/worktree new <name> [from <ref>]`，但分派时直接将 `rest[1]` 当作 `startPoint`。用户按说明输入时，这个值是字面量 `from`，真正的 ref 位于 `rest[2]`，被忽略。

**复现命令：**

```text
/worktree new parser-check from HEAD
```

临时仓库中通过真实命令处理函数复现创建失败。若仓库恰好存在名为 `from` 的引用，还可能从错误起点创建，而不报错。

**修复建议：**显式解析可选的 `from <ref>`，校验缺少 ref 和多余参数的情况，并保持命令提示与文档一致。

**回归验证：**覆盖仅名称、`from HEAD`、`from <分支>`、只有 `from`、多余参数，以及仓库存在名为 `from` 的分支。

## WT06 从 linked worktree 启动会创建嵌套检出

**优先级：P2。**

位置：[worktree.ts](../apps/cli/src/worktree.ts) 的 `addWorktree` 第 241–254 行；启动入口见 [index.ts](../apps/cli/src/index.ts) 的 `resolveWorktreeLaunch` 第 227–246 行。

`repoRoot` 调用 `git rev-parse --show-toplevel`，返回当前检出的根目录。从 linked worktree 启动时，这不是主检出根目录。`addWorktree` 随后以该目录计算存放路径和查找同名 worktree，使同一名称的含义依赖启动位置。

**复现步骤：**

1. 在 `/repo` 创建 `/repo/.nova/worktrees/first`。
2. 从 `first` 内执行 `nova --worktree second`。
3. 从 `first` 内再次执行 `nova --worktree first`。

临时仓库中调用同一创建函数，第二步生成的路径为：

```text
/repo/.nova/worktrees/first/.nova/worktrees/second
```

从主检出执行相同命令时，位置则为 `/repo/.nova/worktrees/second`。第三步没有复用已有 `first`，而是尝试在嵌套路径检出已经被占用的 `worktree-first` 分支，最终失败。

**修复建议：**为存放路径和同名复用统一确定仓库级根目录。同时区分“存放目录的基准”与“新分支的起点”：修复目录定位时，不应意外改变 `baseRef: head` 对起点检出的语义。

**回归验证：**分别从主检出、linked worktree 及其子目录创建或复用同名 worktree，验证路径一致；另外验证 `head`、`fresh` 和显式 ref 的起点。

## 首轮验证结果

审查最终复跑的 8 个相关测试文件全部通过，共 181 项测试；`pnpm typecheck` 通过。

```bash
pnpm vitest run \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/commands/rewind.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/session.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/system-prompt.test.ts \
  packages/base/src/config/config.test.ts

pnpm typecheck
```

上述边界通过临时仓库中的定向调用验证，临时仓库已清理。首轮时的现有测试未覆盖这 6 个问题；各项中的回归验证为当轮建议。首轮未执行全量测试或 OS sandbox 集成测试，不能据此推断所有平台下的沙箱行为。

## 第二轮复审

复审日期：2026 年 10 月 25 日。

本轮对照首轮问题核查修复，并检查创建入口、shell 执行与隔离检查、特殊 Git 布局以及会话重建流程。原始复现场景已有修复，但仍确认 5 个问题，编号继续使用 WT07 至 WT11。这些问题均通过临时仓库中的实际函数调用复现；本轮未修改实现代码。

### 首轮修复情况

| 编号 | 原始场景的修复情况                                                           | 仍需关注的关联问题                                       |
| ---- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| WT01 | 工具侧通过 `resolveToolCwd` 规范化 cwd，权限侧也规范化显式 cwd               | 命令文本中的相对路径仍按 workspace 解析，见 WT07         |
| WT02 | 交互和 headless 启动统一使用 `resolveLaunchTarget`，检查最终工作区的信任状态 | 本轮未复现原问题                                         |
| WT03 | 复制前检查目标的跟踪状态、已存在文件和忽略规则                               | 本轮未复现原问题                                         |
| WT04 | `cdTargets` 已识别换行、子 shell 和花括号分组                                | 环境变量字段仍可重定向 Git，见 WT08                      |
| WT05 | `parseNewWorktreeArgs` 显式解析 `from <ref>` 并检查参数数量                  | Slash 创建流程传入的来源检出不正确，见 WT09              |
| WT06 | 普通仓库下，`addWorktree` 已分离布局根和起点检出，避免嵌套创建               | Slash 调用链和独立 Git 元数据目录仍有问题，见 WT09、WT10 |

这里的修复状态只针对首轮描述的具体场景，不表示整个 worktree 隔离或生命周期已经验证完毕。

### 第二轮问题概览

| 编号 | 优先级 | 问题                                     | 主要位置                                         |
| ---- | ------ | ---------------------------------------- | ------------------------------------------------ |
| WT07 | P1     | 命令中的相对路径未按实际 shell cwd 检查  | `worktree-guard.ts` 的 `worktreeIsolationDenial` |
| WT08 | P1     | env 字段中的 Git 重定向未纳入隔离检查    | `worktree-guard.ts` 的 `worktreeIsolationDenial` |
| WT09 | P2     | Slash 创建流程仍把主检出当作来源         | `commands/worktree.ts` 的 `createAndEnter`       |
| WT10 | P2     | 独立 Git 元数据目录被误识别为主检出      | `worktree.ts` 的 `mainCheckoutRoot`              |
| WT11 | P2     | clear 创建的新会话丢失 worktree 归属信息 | `commands/clear.ts` 的 `handleClear`             |

WT07 和 WT08 复现的是 worktree 隔离检查遗漏。普通权限流程仍然存在；当其批准命令、且没有 OS sandbox 阻止相应操作时，命令可能作用于主检出。

### WT07 命令中的相对路径未按实际 shell cwd 检查

**优先级：P1。**

位置：[worktree-guard.ts](../apps/cli/src/worktree-guard.ts) 的 `worktreeIsolationDenial` 第 162–175 行。

显式 `input.cwd` 已被规范化，但解析 `cd` 和 Git 重定向目标时，`isInsideMain` 仍以 `workspace` 为相对路径基准。工具实际从 `input.cwd` 启动，两处解析结果可能指向不同检出。

**复现条件：**主检出为 `/parent/repo`，会话工作区为 `/parent/repo/.nova/worktrees/first`。传入以下 bash 参数：

```json
{
  "cwd": "/parent",
  "command": "git -C repo rev-parse --show-toplevel"
}
```

临时仓库实测：输入经过 `canonicalizeGateInput` 后，隔离检查仍不拒绝；真实 bash 工具返回主检出路径。检查把 `repo` 理解为 worktree 内的子目录，Git 实际把它理解为 `/parent/repo`。

**修复建议：**命令文本中的相对路径应以实际 shell cwd 为起点解析。处理连续 `cd` 或多次 `git -C` 时，还需考虑前面操作对后续路径基准的影响，不能把所有相对路径独立套到同一个 workspace 上。

**回归验证：**覆盖显式 cwd 位于工作区子目录、主检出之外的目录，以及省略 cwd 的情况；同时验证会进入主检出的调用被拒绝、合法留在 worktree 中的调用不会被误拒绝。

### WT08 env 字段中的 Git 重定向未纳入隔离检查

**优先级：P1。**

位置：[worktree-guard.ts](../apps/cli/src/worktree-guard.ts) 第 159–175 行；环境变量执行路径见 [monitor/tools.ts](../packages/tools/src/monitor/tools.ts) 和 [bash.ts](../packages/tools/src/bash.ts) 的后台分支。

guard 扫描 `command` 文本中的 `GIT_DIR`、`GIT_WORK_TREE`，却没有检查工具的 `input.env`。monitor 和后台 bash 会将该字段传给实际子进程，因此无需在命令文本中出现重定向，也能把 Git 指向主检出。

**复现输入：**在 worktree 会话中调用 monitor，主检出为 `/parent/repo`：

```json
{
  "command": "git rev-parse --show-toplevel",
  "description": "review fixture",
  "env": {
    "GIT_DIR": "/parent/repo/.git",
    "GIT_WORK_TREE": "/parent/repo"
  }
}
```

临时仓库实测：guard 不拒绝，真实 monitor 事件输出主检出路径。后台 bash 使用同一类环境变量传递方式；前台 bash 不使用这个 env 字段，不应把两者混为一谈。

**修复建议：**在实际支持 env 的执行分支中，对 `env.GIT_DIR`、`env.GIT_WORK_TREE` 应用与命令文本一致的隔离规则，并使用实际执行目录解释相对路径。

**回归验证：**分别覆盖 monitor、后台 bash，以及前台 bash 的不同 env 语义；验证指向主检出的值被拒绝，普通无关环境变量仍可使用。

### WT09 Slash 创建流程仍把主检出当作来源

**优先级：P2。**

位置：[commands/worktree.ts](../apps/cli/src/commands/worktree.ts) 的 `createAndEnter` 第 131–137 行，来源见同文件的 `repoFor`。

`addWorktree` 已正确区分布局根与来源检出，但 `/worktree new` 仍将 `repoFor` 返回的主检出作为 `opts.repo`。因此库函数的修复没有完整传递到 Slash 入口：`HEAD`、`baseRef: head` 和包含文件复制仍以主检出为来源。

**复现步骤：**

1. 在主检出创建 worktree `first`。
2. 在 `first` 中新增独立提交，使其 HEAD 与主检出不同。
3. 主检出的 `.env` 写为 `SOURCE=main`，`first` 的 `.env` 写为 `SOURCE=first`，并使用 `.worktreeinclude` 包含该文件。
4. 在 `first` 会话中执行 `/worktree new second from HEAD`。

通过真实 `createContext` 和 `handleWorktree` 复现：`second` 的 HEAD 等于主检出的 HEAD，而非 `first`；复制的 `.env` 内容为 `SOURCE=main`。

**修复建议：**创建操作向 `addWorktree` 传入当前 `ctx.workspace`，让它自行确定布局根。列出、删除等仓库级操作可以继续使用主检出定位，不应与创建时的来源参数混用。

**回归验证：**通过真实 Slash 处理函数验证 `from HEAD`、`baseRef: head`、`fresh` 回退到 HEAD 和包含文件复制。只测试 `addWorktree` 无法覆盖这层参数传递错误。

### WT10 独立 Git 元数据目录被误识别为主检出

**优先级：P2。**

位置：[worktree.ts](../apps/cli/src/worktree.ts) 的 `mainCheckoutRoot` 第 60–63 行；同文件 `worktreeBinding` 也使用 `dirname(common)` 推断主检出。

新增 `gitDir` 字段让 sandbox 可以使用真实公共 Git 目录，但主检出识别仍假定公共 Git 目录的父目录就是检出根。使用 `git init --separate-git-dir` 时，这个假设不成立。

**复现布局：**

```text
/tmp/example/separate-repo       实际工作目录
/tmp/example/metadata/gitdir     独立 Git 元数据目录
```

临时仓库实测：`mainCheckoutRoot` 返回 `/tmp/example/metadata`，普通检出被 `worktreeBinding` 误判成 linked worktree；随后 `addWorktree` 在该错误目录调用 Git，报 `not a git repository`。

**修复建议：**区分工作目录根、当前检出的 Git 目录和公共 Git 目录。不能仅通过 `dirname(gitCommonDir)` 推断主检出；对无法可靠识别的布局应明确处理，避免以元数据父目录继续执行仓库操作。

**回归验证：**使用真实 `git init --separate-git-dir` 建仓，验证普通检出识别、worktree 创建及 sandbox Git 写入路径。仅给 `sandboxGitAllowWrite` 传一个非标准路径的单元测试不能验证整个流程。

### WT11 clear 创建的新会话丢失 worktree 归属信息

**优先级：P2。**

位置：[commands/clear.ts](../apps/cli/src/commands/clear.ts) 的 `handleClear` 第 20–23 行；恢复判断见 [session.ts](../apps/cli/src/session.ts) 的 `resolveSession`。

正常启动时创建会话会记录 `worktreeMain`，但 `/clear` 创建新会话时只传入 workspace。后续恢复依赖 `session.json` 中的 `worktree.main` 区分“已删除的 worktree”和“不属于当前目录的普通会话”，因此这项遗漏会改变恢复行为。

**复现步骤：**

1. 在 worktree 中建立有历史消息的会话。
2. 执行 `/clear`，创建新的会话。
3. 删除该 worktree 目录。
4. 从主检出使用 `--resume <新会话 id>` 恢复。

通过真实 `handleClear` 复现：新 metadata 没有 `worktree.main`，第四步抛出 workspace mismatch，无法走已有的“检出删除后退回启动目录”逻辑。

**修复建议：**`/clear` 创建会话时保存当前 worktree 的主检出信息，与正常新建会话保持一致。

**回归验证：**在 linked worktree 内通过真实 `/clear` 路径创建会话，检查 metadata；删除检出后应能从主检出恢复。普通目录中的 `/clear` 应保持现有行为。

### 第二轮验证结果

14 个相关测试文件、228 项测试全部通过，`pnpm typecheck` 通过。

```bash
pnpm vitest run \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/worktree-launch.test.ts \
  apps/cli/src/launch.test.ts \
  apps/cli/src/commands/worktree.test.ts \
  apps/cli/src/commands/rewind.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/session.test.ts \
  apps/cli/src/path-safety.test.ts \
  packages/tools/src/cwd.test.ts \
  packages/tools/src/monitor/tools.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/system-prompt.test.ts \
  packages/base/src/config/config.test.ts

pnpm typecheck
```

这轮现有测试未覆盖 WT07 至 WT11 的完整场景，问题由额外的临时仓库验证确认，临时仓库已清理。本轮未执行全量测试或 OS sandbox 集成测试。

## 第三轮复审

复审日期：2026 年 10 月 25 日。

本轮对照第二轮问题核查修复，重点检查 shell 命令解析、Git 重定向和独立 Git 元数据目录下的完整创建切换流程。确认 4 个问题，编号为 WT12 至 WT15，均在临时仓库中复现。审查未修改实现代码。

### 第二轮修复情况

| 编号 | 原始场景的修复情况 | 仍需关注的关联问题 |
| ---- | ------------------ | ------------------ |
| WT07 | 命令中的相对路径已按显式 cwd 解析，并跟踪连续 cd 和 git -C | shell 作用域与条件执行仍会导致目录推导错误，见 WT12；路径未解析符号链接，见 WT13 |
| WT08 | monitor 和后台 bash 的 env 已纳入检查，前台 bash 保持其忽略 env 的语义 | 独立 Git 目录布局允许 GIT_DIR 指向共享元数据，见 WT14 |
| WT09 | Slash 创建流程已向 addWorktree 传入当前 ctx.workspace | 真实命令处理流程已有来源 HEAD 和包含文件复制的回归测试 |
| WT10 | 独立 Git 目录的普通检出不再被误判，直接调用 addWorktree 可以创建 | 创建后的会话切换仍失败，见 WT15；此项尚未完整解决 |
| WT11 | clear 创建新会话时已传递 worktreeMain | 真实 clear 路径已有元数据保留及删除检出后恢复的回归测试 |

### 第三轮问题概览

| 编号 | 优先级 | 问题 | 主要位置 |
| ---- | ------ | ---- | -------- |
| WT12 | P1 | cd 的目录变化错误地跨越 shell 作用域和执行分支 | worktree-guard.ts 的 commandDenial |
| WT13 | P1 | 命令路径未解析符号链接，漏过主检出检查 | worktree-guard.ts 的 resolveAgainst |
| WT14 | P1 | 允许共享目录作为 GIT_DIR，导致主检出索引被修改 | worktree-guard.ts 的 isProtected |
| WT15 | P2 | 独立 Git 目录下创建成功后无法切入 worktree | context.ts 的 setWorkspace |

WT12 至 WT14 中的“放行”指 worktree 隔离检查返回 `undefined`，普通权限流程仍会执行。WT12、WT13 验证了实际 Git 访问的检出；WT14 进一步验证了主检出暂存区被修改。真实运行中的修改还取决于普通权限与 OS sandbox；本轮定向验证未启用 OS sandbox。

### WT12 cd 的目录变化错误地跨越 shell 作用域和执行分支

**优先级：P1。**

位置：[worktree-guard.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/worktree-guard.ts:343) 的 `commandDenial`；关联逻辑为 `splitShellCommands`。

`splitShellCommands` 把括号、管道和条件连接符作为分隔符丢弃，随后 `commandDenial` 对所有 `cd` 统一更新 `shellCwd`。这相当于假定每个 `cd` 都成功执行且影响后续所有命令，没有保留子 shell 的作用域，也没有保留命令失败后的执行分支。

**复现条件：**主检出为 `/repo`，会话工作区为 `/repo/.nova/worktrees/feat`，其中有一个 `sub` 目录，且没有 `nonexistent` 目录。

```bash
(cd sub); git -C .. rev-parse --show-toplevel
```

guard 把后续 Git 的 cwd 当作 `feat/sub`，因此认为 `-C ..` 回到 `feat`，允许执行。实际子 shell 退出后，外层仍在 `feat`；Git 的 `-C ..` 进入 `/repo/.nova/worktrees`，向上发现主检出的 `.git`。临时仓库实测：隔离检查返回 `undefined`，真实命令返回主检出根目录。

以下失败分支得到相同结果：

```bash
cd nonexistent || git -C .. rev-parse --show-toplevel
```

这里 `cd` 实际失败，外层 cwd 未改变；guard 却按已成功进入 `nonexistent` 继续推导。将读取命令替换成修改索引或检出的 Git 操作，会使错误的目录判断影响主检出。

**修复建议：**保留 shell 作用域和条件执行语义，不能把所有片段压平成无条件的目录变换。对无法可靠推导 cwd 的分支应保守处理，避免将不确定路径认定为 worktree 内路径。

**回归验证：**覆盖子 shell、管道、失败后的 `||` 分支、普通分组和连续成功的 `cd`；同时执行真实 shell，对照 guard 推导与 Git 实际访问的检出。

### WT13 命令路径未解析符号链接

**优先级：P1。**

位置：[worktree-guard.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/worktree-guard.ts:268) 的 `resolveAgainst`。

`resolveAgainst` 只调用 `path.resolve`，得到词法上的绝对路径，没有解析符号链接。外层 `canonicalizeGateInput` 虽然会规范化显式 `input.cwd`，却不会处理 `command` 文本中的 `cd`、`git -C` 等路径，因此这条调用链仍可能把实际指向主检出的路径判为 worktree 内路径。

**复现步骤：**在 `/repo/.nova/worktrees/feat` 内，创建指向主检出 `/repo` 的符号链接，再执行 Git：

```bash
ln -s /repo main-link
git -C main-link rev-parse --show-toplevel
```

临时仓库实测：guard 根据 `feat/main-link` 的词法位置放行，真实 Git 返回主检出路径。若普通权限允许后续写操作，就可能修改主检出的文件或 Git 状态。

**修复建议：**命令路径与工具的显式 cwd 应使用一致的真实路径规范化规则，检查符号链接解析后的目标；同时正确处理路径不存在时的已有父目录。

**回归验证：**覆盖 `cd`、`git -C` 和 Git 重定向路径中的符号链接，分别验证指向主检出的链接被拒绝、指向当前 worktree 内部的链接正常使用。

### WT14 共享 Git 目录重定向会修改主检出的索引

**优先级：P1。**

位置：[worktree-guard.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/worktree-guard.ts:142) 的 `isProtected`；相关测试为 `worktree-guard.test.ts` 中允许 env 指向共享 Git 目录的用例。

独立 Git 元数据目录布局下，linked worktree 的 `main` 可能无法推导。此时 `isProtected` 通过向上查找 `.git` 判断目标属于哪个检出，但共享 Git 目录本身不含这样的工作目录标记，因而被判定为无需保护。显式把 `GIT_DIR` 指向该目录的命令文本和 env 字段都能漏过检查。

**复现布局：**

```text
/tmp/example/work                       主检出
/tmp/example/metadata/gitdir            共享 Git 目录
/tmp/example/work/.nova/worktrees/feat  linked worktree
```

在 linked worktree 内创建 `marker.txt`，再执行：

```bash
GIT_DIR=/tmp/example/metadata/gitdir git add marker.txt
```

临时仓库实测：命令文本检查和后台 bash 的同等 `env.GIT_DIR` 检查均返回 `undefined`。真实执行上述命令后，从两个检出分别查询 `git diff --cached --name-only`，结果为：

```text
主检出：       marker.txt
linked worktree：空
```

正常 linked worktree 使用 `<common>/worktrees/<name>` 中专属的 `HEAD` 和 index，并通过 Git 的共享目录机制访问对象数据库。显式设置 `GIT_DIR=<common>` 会选用主检出的 `HEAD` 和 index；允许共享对象库写入，并不等于可以把整个共享目录作为当前 worktree 的 `GIT_DIR`。现有允许用例的注释混淆了这两种行为。

**修复建议：**区分公共对象存储与每份检出专属的 Git 状态。没有可命名的主检出时，也应阻止重定向到主检出的 index、HEAD 等状态，并修正允许 `GIT_DIR=<common>` 的测试预期。

**回归验证：**使用真实 `--separate-git-dir` 仓库，分别验证命令文本、monitor env 和后台 bash env；检查主检出与 linked worktree 各自的暂存区和 HEAD，而非只断言 guard 返回值。正常 worktree 的 add、commit 应继续可用。

### WT15 独立 Git 目录下创建成功后无法切入 worktree

**优先级：P2。**

位置：[context.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/context.ts:1578) 的 `setWorkspace`。

`setWorkspace` 通过主检出路径判断两个目录是否属于同一仓库。从独立 Git 目录的主检出出发，`currentRepo` 可以确定；但新 linked worktree 的主检出路径无法由当前实现推导，`nextRepo` 为 `undefined`，随即触发“not inside”错误。虽然 `addWorktree` 的创建逻辑已修复，Slash 命令的创建后切换流程仍未打通。

**复现步骤：**

1. 使用 `git init --separate-git-dir <metadata/gitdir>` 初始化主检出，并提交一个文件。
2. 从该主检出建立 CLI context。
3. 执行 `/worktree new feat`。

通过真实 `createContext` 和 `handleWorktree` 复现：Git worktree 及 `worktree-feat` 分支已创建，但命令显示 `refusing to switch to ...: not inside ...`，`ctx.workspace` 仍为主检出。创建留下的 worktree 没有被切入。

**修复建议：**使用双方的 `gitCommonDir` 判断仓库身份，将仓库身份与是否能找到主检出路径分开处理，并保留拒绝跨仓库切换的约束。

**回归验证：**从独立 Git 目录的主检出通过真实 Slash 处理函数创建并切入 worktree，验证当前 workspace 和会话绑定；同时验证同仓库的其他检出可以切换、不同仓库仍被拒绝。单独测试 `addWorktree` 不足以覆盖此问题。

### 第三轮验证结果

14 个相关测试文件、251 项测试全部通过，`pnpm typecheck` 通过。执行的测试文件与第二轮相同：

```bash
pnpm vitest run \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/worktree-launch.test.ts \
  apps/cli/src/launch.test.ts \
  apps/cli/src/commands/worktree.test.ts \
  apps/cli/src/commands/rewind.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/session.test.ts \
  apps/cli/src/path-safety.test.ts \
  packages/tools/src/cwd.test.ts \
  packages/tools/src/monitor/tools.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/system-prompt.test.ts \
  packages/base/src/config/config.test.ts

pnpm typecheck
```

WT12 至 WT15 由额外的临时仓库定向验证确认，临时仓库已清理。WT14 的现有测试允许了错误的共享 Git 目录重定向，其余问题的上述复现场景未被现有测试覆盖。本轮未执行全量测试或 OS sandbox 集成测试。

## 第四轮复审

复审日期：2026 年 10 月 25 日。

本轮按 shell 隔离和特殊 Git 布局两个根因核查第三轮修复，确认仍有 2 个 P2 问题：一个是新增 env 分支造成的检查回归，编号为 WT16；另一个是 WT13 的剩余场景，沿用原编号，不作为独立的新问题累计。上一轮其余原始复现场景已通过验证，独立 Git 目录下的创建、切换与跨仓库拒绝测试通过。

两项问题均需要特定命令形式触发，普通权限流程仍然有效。本轮按具体触发条件和影响范围评为 P2；WT13 的历史 P1 记录保留在第三轮，本轮残留场景以此处评级为准。审查未修改实现代码。

### 第三轮修复情况

| 编号 | 本轮核查结果 | 剩余范围 |
| ---- | ------------ | -------- |
| WT12 | 原始子 shell、失败 cd 和管道场景已有回归测试，真实 shell 对照验证通过 | 复杂条件命令仍采取保守拒绝策略，本轮未将该设计限制另列问题 |
| WT13 | 普通符号链接路径现在可以正确识别并拒绝 | 符号链接后接 `..` 时仍与 Git 实际路径不同，见下文 WT13 复核 |
| WT14 | 直接设置 GIT_DIR、工具 env 及 git-dir 参数指向共享目录的原始场景已修复 | 新增 env 包装命令分支绕过赋值检查，见 WT16；普通仓库也受影响 |
| WT15 | 仓库身份改用共享 Git 目录比较，创建后能切入 worktree | 独立 Git 目录下返回主检出、切换同仓库检出和拒绝跨仓库切换的测试通过 |

### 第四轮问题概览

| 编号 | 优先级 | 性质 | 问题 | 主要位置 |
| ---- | ------ | ---- | ---- | -------- |
| WT16 | P2 | 本轮回归 | env 分支跳过 Git 环境变量检查 | worktree-guard.ts 的 walkTokens |
| WT13 | P2 | 原问题残留 | 符号链接后接 .. 时提前折叠路径 | path-safety.ts 的 canonicalizePathSync |

以下“放行”均指 worktree 隔离检查返回 `undefined`，不代表绕过所有权限机制。定向验证在临时仓库中执行，未启用 OS sandbox。

### WT16 env 分支跳过 Git 环境变量检查

**优先级：P2。本轮回归。**

位置：[worktree-guard.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/worktree-guard.ts:651) 的 `walkTokens` 第 651–657 行。

新增 env 分支遇到 `NAME=value` 时直接跳过，随后只把剩余命令交给递归调用并提前返回。原本位于函数后部的 `GIT_*` 赋值检查因此看不到 env 消费的变量。直接写 `GIT_DIR=... git ...` 会经过检查，前面加上 env 后却绕过了同一规则。

**复现条件：**主检出为 `/repo`，会话工作区为 `/repo/.nova/worktrees/feat`，在 worktree 内新建 `marker.txt`。

```bash
env GIT_DIR=/repo/.git git add marker.txt
```

临时仓库实测：隔离检查返回 `undefined`。实际执行后，从两份检出分别查询 `git diff --cached --name-only`，主检出列出 `marker.txt`，当前 worktree 的暂存区为空。相同条件下，去掉 env 的写法会被隔离检查拒绝：

```bash
GIT_DIR=/repo/.git git add marker.txt
```

另以 `env GIT_DIR=/repo/.git GIT_WORK_TREE=/repo git rev-parse --show-toplevel` 验证，guard 放行，真实 Git 返回主检出根目录。该问题不依赖独立 Git 元数据目录布局。

**修复建议：**处理 env 包装命令时保留其环境变量，并在子命令的有效执行目录下应用 Git 重定向检查；不能仅跳过赋值后递归处理命令部分。

**回归验证：**比较直接赋值与 env 包装两种写法，覆盖 `GIT_DIR`、`GIT_WORK_TREE` 及 env 改变 cwd 的情况；验证指向主检出的调用被拒绝、合法 worktree 状态和普通环境变量仍可使用。

### WT13 复核 符号链接后接 .. 时仍会判断错误

**优先级：P2。上一轮问题的残留。**

位置：[path-safety.ts](/Volumes/workspace/Github/nova-code/packages/base/src/host/path-safety.ts:43) 的 `canonicalizePathSync` 第 43–44 行；调用点为 [worktree-guard.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/worktree-guard.ts:553) 的 `resolveToken`。

新增同步规范化函数先调用 `resolve(cwd, rawPath)`，再解析符号链接。`resolve` 会先把 `link/..` 折叠掉，符号链接目标因此没有机会参与判断。Git 对 `-C` 参数执行真实目录切换，遍历符号链接与 `..` 的结果可能不同。

**复现布局：**

```text
/repo/main-sub                         主检出中的子目录
/repo/.nova/worktrees/feat             当前 worktree
/repo/.nova/worktrees/feat/main-link   符号链接，指向 /repo/main-sub
```

在当前 worktree 内执行：

```bash
git -C main-link/.. rev-parse --show-toplevel
```

guard 在解析链接前将 `main-link/..` 折叠为当前 worktree，因而放行。真实 Git 先进入链接目标 `/repo/main-sub`，再取其父目录，返回主检出根目录 `/repo`。

临时仓库实测确认上述差异；对照命令 `git -C main-link rev-parse --show-toplevel` 现在会被正确拒绝，说明普通符号链接场景已修复，残留集中在链接与 `..` 的组合。

**修复建议：**命令路径检查必须匹配 Git 的实际路径遍历语义，不能提前词法折叠会经过符号链接的 `..`；无法可靠解析的组合应保守处理。不要只以同步与异步规范化函数返回一致作为正确性的依据。

**回归验证：**在真实仓库中对照 guard 与 Git，覆盖 `link`、`link/..`、多级链接，以及链接指向主检出和当前 worktree 内部的情况。

### 第四轮验证结果

15 个相关测试文件、273 项测试全部通过，`pnpm typecheck` 通过。相比第三轮，增加了基础路径规范化测试文件：

```bash
pnpm vitest run \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/worktree-launch.test.ts \
  apps/cli/src/launch.test.ts \
  apps/cli/src/commands/worktree.test.ts \
  apps/cli/src/commands/rewind.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/session.test.ts \
  apps/cli/src/path-safety.test.ts \
  packages/tools/src/cwd.test.ts \
  packages/tools/src/monitor/tools.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/system-prompt.test.ts \
  packages/base/src/config/config.test.ts \
  packages/base/src/host/path-safety.test.ts

pnpm typecheck
```

现有测试未覆盖本轮两项问题的上述复现场景，问题由额外的临时仓库定向验证确认。临时仓库已清理；本轮未执行全量测试或 OS sandbox 集成测试。

## 第五轮复审

复审日期：2026 年 10 月 25 日。

本轮核查 WT16 和 WT13 的修复，并沿共享路径函数的调用链检查权限、文件访问约束和实际读写行为。两个原始复现场景已修复，但共享 `canonicalizePath` 的语义变更引入一项整体回归，编号为 WT17，优先级 P1。该问题已通过真实 `createContext`、`checkPermission` 和 dispatcher 复现，未按受影响工具拆分计数。审查未修改实现代码。

### 第四轮修复情况

| 编号 | 本轮核查结果 | 关联影响 |
| ---- | ------------ | -------- |
| WT16 | env 分支保留并传递 GIT_* 赋值，原始重定向场景已被拒绝；新增测试通过 | 本轮未复现原问题 |
| WT13 | 路径规范化保留原始组件并使用 native realpath，Git 的 link/.. 原始场景已有真实 shell 对照测试 | 同时改变了文件工具共用的异步 canonicalizePath，但工具执行端没有同步调整，见 WT17 |

### 第五轮问题概览

| 编号 | 优先级 | 性质 | 问题 | 主要位置 |
| ---- | ------ | ---- | ---- | -------- |
| WT17 | P1 | 本轮整体回归 | 路径检查与文件工具实际读写目标不一致 | path-safety.ts 的 canonicalizePath；read/write/edit 的路径解析 |

### WT17 路径检查与文件工具实际读写目标不一致

**优先级：P1。本轮整体回归。**

位置：[path-safety.ts](/Volumes/workspace/Github/nova-code/packages/base/src/host/path-safety.ts:38) 的 `canonicalizePath` 第 38–39 行。权限调用见 [CLI path-safety.ts](/Volumes/workspace/Github/nova-code/apps/cli/src/path-safety.ts:78)，实际写入路径见 [write.ts](/Volumes/workspace/Github/nova-code/packages/tools/src/write.ts:34)。

本轮将共享 `canonicalizePath` 改为按真实文件系统顺序遍历路径，先经过符号链接，再解释后续 `..`。权限检查和 read-before-edit 约束都使用这个函数，但 `read`、`write`、`edit` 工具仍先调用 `path.resolve(ctx.cwd, input.path)`，在解析符号链接前就折叠 `..`。权限侧规范化后的输入仅用于判断，工具仍收到原始路径，因此检查与执行可能指向不同文件。

**复现条件：**主检出为 `/repo`，当前 worktree 为 `/repo/.nova/worktrees/feat`，两份检出都已有 `victim.txt`。布局如下：

```text
/repo/victim.txt                         主检出文件
/repo/.nova/worktrees/feat/victim.txt     worktree 文件
/repo/.nova/worktrees/feat/sub            worktree 子目录
/repo/worktree-link                      符号链接，指向 worktree 的 sub 目录
```

**复现步骤：**

1. 从 worktree 创建真实 CLI context，使用 `acceptEdits` 权限模式。
2. 通过 `read` 工具读取 worktree 内的 `victim.txt`，使该文件有有效读取记录；不读取主检出的同名文件。
3. 对以下输入执行 `checkPermission`，获准后通过 dispatcher 调用 `write`：

```json
{
  "path": "/repo/worktree-link/../victim.txt",
  "content": "OVERWRITTEN\n"
}
```

两种路径处理得到的目标不同：

| 阶段 | 解析规则 | 判断或操作的文件 |
| ---- | -------- | ---------------- |
| 权限与文件访问约束 | 先跟随 worktree-link 到 worktree/sub，再处理 .. | `/repo/.nova/worktrees/feat/victim.txt` |
| write 工具执行 | path.resolve 先消去 worktree-link/.. | `/repo/victim.txt` |

临时仓库实测结果：

```text
直接写主检出 victim.txt：checkPermission.granted = false
使用链接加 .. 的路径：checkPermission.granted = true
定向 invariants.preCheck：ok = true
真实 dispatcher：写入成功，返回主检出的 victim.txt 路径
主检出文件内容：OVERWRITTEN
worktree 文件内容：仍为原始内容
```

这项 P1 评级依据是实际文件覆盖：`acceptEdits` 将调用视为工作区内写入而自动允许，主检出的原有文件随后被覆盖。验证使用文件工具完成，没有执行 shell 写命令，也没有启用 `bypassPermissions`。工具的读取记录和检查目标正确地指向 worktree 文件，却不能保护执行端实际修改的主检出文件。

同一根因涉及 `read`、`write`、`edit` 的路径解释；本轮已直接复现的是 `write` 覆盖主检出，不将各工具分别记为新问题。

**修复建议：**让权限检查、文件访问约束和实际文件工具使用同一个最终目标，统一整条调用链的路径语义。Git 命令仍需保持真实路径遍历的检查方式，不能为恢复文件工具的一致性而直接撤回 WT13 的修复。应明确各消费者的执行规则，避免只修改共享辅助函数的一端。

**回归验证：**通过真实权限入口与 dispatcher 验证上述布局，确认检查目标与实际读写文件一致；覆盖 `read`、`write`、`edit`，并核对读取记录、同文件执行键和快照记录都对应实际文件。同步与异步规范化函数彼此一致，以及它们单独通过单元测试，都不足以验证工具执行端的一致性。

### 第五轮验证结果

18 个相关测试文件、349 项测试全部通过，`pnpm typecheck` 通过。除第四轮的测试范围外，本轮增加文件访问约束、权限引擎和 dispatcher 测试：

```bash
pnpm vitest run \
  apps/cli/src/worktree.test.ts \
  apps/cli/src/worktree-guard.test.ts \
  apps/cli/src/worktree-launch.test.ts \
  apps/cli/src/launch.test.ts \
  apps/cli/src/commands/worktree.test.ts \
  apps/cli/src/commands/rewind.test.ts \
  apps/cli/src/context.smoke.test.ts \
  apps/cli/src/session.test.ts \
  apps/cli/src/path-safety.test.ts \
  packages/tools/src/cwd.test.ts \
  packages/tools/src/monitor/tools.test.ts \
  packages/agent/src/session.test.ts \
  packages/agent/src/system-prompt.test.ts \
  packages/base/src/config/config.test.ts \
  packages/base/src/host/path-safety.test.ts \
  packages/safety/src/invariants.test.ts \
  packages/safety/src/permission.test.ts \
  packages/tools/src/dispatcher.test.ts

pnpm typecheck
```

现有测试未覆盖 WT17 的上述完整调用链，问题由额外的临时仓库定向验证和真实 CLI context 验证确认。临时仓库已清理；本轮未执行全量测试或 OS sandbox 集成测试。
