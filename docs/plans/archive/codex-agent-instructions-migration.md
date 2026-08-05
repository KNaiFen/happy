# Codex Agent 指令与 Claude 遗留清理计划

> **历史归档（2026-08-05）：** 本计划已完成；当前 provider 边界以 ADR-003 和代码为准。

## 状态

已完成。本文记录本轮迁移的权威范围、实施结果和验收证据；Codex Desktop
local environment action 仍是独立的人工 UI 验收项，不影响代码与云端门禁结论。

### 执行进度

- [x] 完成 Claude/Codex 指令、技能、配置、活跃文档和现有 CI 门禁盘点。
- [x] 迁移本地 Agent 指令、技能和 lab-rat 模板；Desktop local environment
      action 因官方 UI-only 边界保留为人工验收项。
- [x] 清理活跃文档并补充最终 Codex-only ADR。
- [x] 重构 Codex-only CI 门禁并证明官方 app-server 加载 `AGENTS.md`。
- [x] 完成本地源码验证、提交、推送和云端验收。

## 目标

把当前项目仍在使用的 Agent 指令、技能和本地开发入口统一迁移到 Codex 支持的格式，删除会继续制造 Claude 配置或误导用户的遗留文件，同时保留必要的历史证据、第三方名称和 Codex 仍依赖的安全组件。

本轮不是恢复或重写 Claude provider。Codex 继续是所有未指定新会话的唯一默认 Agent，Sync v4、stable-v2 和最低 `codex-cli 0.145.0` 边界不变。

## 已确认现状

### `CLAUDE.md`

仓库和忽略的本地环境中共发现 14 份 `CLAUDE.md`：

- `environments/lab-rat-todo-project/CLAUDE.md`
- `environments/data/envs/*/project/CLAUDE.md` 共 13 份

它们 SHA-256 完全相同，且都只有一行：

```text
Read ./agents.md for instructions.
```

因此 `CLAUDE.md` 本身没有需要保留的工程知识。实际内容位于同目录 `agents.md`，包括测试夹具定位、已知缺陷和逐步执行 `exercise-flow.md` 的要求。

### `.claude/`

发现以下仍有内容的本地文件：

| 来源 | 内容 | 处理方向 |
| --- | --- | --- |
| `.claude/settings.json` | Claude Bash 白名单：pnpm/yarn typecheck、git fetch、npm view、pnpm lint | 不机械转换权限；把仍有效的验证约束并入 `AGENTS.md`，删除过时 yarn 和宽泛网络白名单 |
| `.claude/launch.json` | 启动 `packages/happy-app` Web 开发服务，端口 8081 | 用 Codex/ChatGPT desktop local environment action 重新生成并验证，不猜测私有文件结构 |
| `.claude/skills/agent-browser` | 浏览器测试技能 | 与 `.agents/skills/agent-browser` 字节完全一致，直接删除重复副本 |
| `.claude/skills/terminal-emulator` | CLI/TUI 测试技能 | 与 `.agents/skills/terminal-emulator` 字节完全一致，直接删除重复副本 |
| `packages/happy-app/.claude/settings.json` | 允许运行 changelog 解析脚本 | 不迁移为宽泛命令授权；按任务需要走 Codex 审批和项目规则 |
| `packages/happy-app/.claude/agents/i18n-translator.md` | Claude 专用翻译子代理 | 重写为 repo 级 Codex skill |

旧翻译代理只列出 `en/ru/pl/es`，而当前 App 实际支持 `en/ru/pl/es/it/pt/ca/zh-Hans/zh-Hant/ja`，不能原样搬运。

实施盘点进一步确认 `packages/happy-app/sources/scripts/compareTranslations.ts`
也只导入其中 7 种语言，漏掉 `it`、`zh-Hant` 和 `ja`。本轮必须同时修正
该源码级校验器，否则新 skill 的“检查全部支持语言”无法得到真实验证。

### 已有 Codex 格式

- 根项目规则使用 `AGENTS.md`。
- repo 级技能已位于 `.agents/skills/*/SKILL.md`。
- 当前没有项目级 `.codex/config.toml`。
- 官方 Codex 支持以 `AGENTS.md` 表示目录指令、以 `.agents/skills/<name>/SKILL.md` 表示技能、以项目 `.codex/` 表示可信项目配置和 desktop local environment。

## 固定边界

### 必须删除或迁移

- 所有项目内 `CLAUDE.md`、`CLAUDE.local.md` 和 `.claude/` Agent 配置。
- 会重新生成 `CLAUDE.md` 的模板、脚本或文档说明。
- 跟踪中的 `packages/happy-cli/agents.md` 不是 Codex 原生入口，且仍指向已删除
  的 provider 测试；把有效的测试分层迁入普通工程文档后删除，不能通过改名为
  可提交的嵌套 `AGENTS.md` 绕过本地指令策略。
- 活跃 README、隐私说明、架构说明和使用指南中仍宣称 Happy 可以启动或控制 Claude 的内容。
- 已失效但仍放在 `docs/plans/` 活动目录中的 Claude SDK、Claude permission 或 `happy claude` 实施计划。
- CI 中以 Claude 为中心的任务名和脚本名，改成 Codex-only provider boundary。

### 必须保留

- `@anthropic-ai/sandbox-runtime`：Codex sandbox 仍直接依赖该安全组件，包名不能作为删除依据。
- `happy claude`、`agent === 'claude'` 等显式拒绝旧输入的负向守卫及其测试。
- 清理 `claudeSessionId` 等旧元数据的单向 sanitization。
- Agy 等第三方 provider 真实暴露的 Claude 模型名称。
- 不可更改的 App Store URL slug `happy-claude-code-client`。
- `docs/competition/claude/`、研究资料和历史 changelog；它们是带来源的研究或已发布历史，不是活跃兼容层。
- 既有 ADR 的历史内容。被替代的段落必须标记 superseded 并链接新 ADR，不直接抹除。

### 禁止的做法

- 不做全仓库 `Claude -> Codex` 文本替换。
- 不把 Claude `permissions.allow` 语法直接翻译成更宽松的 Codex sandbox 或 `approval_policy = "never"`。
- 不因包名带 Anthropic 就移除 Codex sandbox。
- 不把未知、空值或 legacy provider 元数据重新分类为可写 Codex。
- 不删除竞品研究、历史制品说明或负向兼容守卫来制造“零匹配”假象。

## 目标目录结构

```text
AGENTS.md
.agents/
  skills/
    agent-browser/SKILL.md
    terminal-emulator/SKILL.md
    i18n-translator/SKILL.md
.codex/
  <由 Codex desktop 生成并人工复核的本地环境配置>
environments/
  lab-rat-todo-project/
    AGENTS.template.md
    README.md
    exercise-flow.md
```

`AGENTS.md`、`.agents/` 和 `.codex/` 继续遵守本项目的本地文件策略，不提交。测试夹具需要进入 Git 的指令源使用 `AGENTS.template.md`；创建环境时确定性地生成目标项目的 `AGENTS.md`，从而兼顾 Codex 原生发现和本地 AI 文件不入库规则。

## 实施步骤

### 1. 修订根 `AGENTS.md`

- 新增 `Product And Protocol Boundaries`：Codex 默认、Claude 主动能力禁止恢复、未知 provider 不得推断为 Codex。
- 新增 `Codex Gateway Boundaries`：stable-v2、最低 `0.145.0`、禁止 experimental、只同步 reasoning summary、禁止超时伪完成。
- 新增 `Sync And Security Boundaries`：Socket invalidation 非事实源、日志无 payload、可信网络 HTTP 与 Web HTTPS/localhost 边界。
- 补齐 Cloud Release：CLI、Android App、Debian relay、happy-agent、官方 Codex source 和 Android field E2E。
- 新增计划归档和 `.agents` 压缩规则。
- 合并重复的 patch version 规则，并明确 Server、Wire、happy-agent 和 Codium 的联动版本判断。
- 把“所有忽略规则只能放 `.git/info/exclude`”改成“新增本地规则放 `.git/info/exclude`，保留仓库已有的通用忽略项”。

### 2. 迁移 Claude 本地配置

- 删除根 `.claude/settings.json` 和 App `.claude/settings.json`。
- 不迁移 `yarn typecheck`；本项目继续使用 pnpm。
- 不迁移 `npm view *` 或 `git fetch*` 为永久免审批规则。
- 保留的意图由 `AGENTS.md` 表达：本地只运行源码级 typecheck、直接测试和 dev server；构建与制品检查进入 Actions。
- 在 Codex desktop 中创建 App Web local environment action，命令保持 `pnpm --dir packages/happy-app web`、端口 8081；检查 Codex 生成的 `.codex` 文件后再保留，禁止手写未公开 schema。
- 验证新 Codex 会话能发现该 action 后，删除 `.claude/launch.json`。

执行中确认：Codex 官方文档只公开了 Desktop 设置入口，没有公开可安全手写的
local environment 文件 schema；当前自动化会话也被应用自控安全策略禁止操作
`com.openai.codex`。因此 `.claude/launch.json` 已删除，避免继续生效；对应 App Web
action 保留为推送后的人工验收项，由用户在 Codex Desktop 设置中生成。不得为了
让清单显示完成而伪造 `.codex` 文件。

### 3. 迁移技能

- 删除 `.claude/skills/agent-browser` 和 `.claude/skills/terminal-emulator`，因为 Codex 版本已经存在且内容相同。
- 将 `packages/happy-app/.claude/agents/i18n-translator.md` 重写为 `.agents/skills/i18n-translator/SKILL.md`。
- 新 skill 只保留 `name`、精准 `description` 和工作流正文，不携带 Claude 的 `tools`、`model`、`color` frontmatter。
- 翻译语言从 `packages/happy-app/sources/text/_all.ts` 和 `translations/` 动态确认，不能硬编码旧四语言清单。
- 修正 `compareTranslations.ts`，使其覆盖 `_all.ts` 声明的全部 10 种语言；新增语言后若校验器遗漏，TypeScript 或测试必须失败。
- 工作流要求所有支持语言结构一致、动态参数类型一致、设置说明允许换行、紧凑按钮文字单独检查，并运行现有源码级 translation comparison/typecheck。
- 用应触发、间接触发、不应触发和缺少上下文四类提示验证 skill 路由。

### 4. 把测试夹具改成 Codex 原生指令

- 将跟踪中的 `environments/lab-rat-todo-project/agents.md` 改为 `AGENTS.template.md`。
- 内容改成 Codex/Happy Codex app-server 测试夹具说明，删除 Claude Code 入口描述；保留已知缺陷和 `exercise-flow.md` 逐步执行约束。
- `copyLabRatProject()` 在目标目录写出 `AGENTS.md`，不复制 `AGENTS.template.md` 或 `agents.md`。
- 在 macOS 等大小写不敏感文件系统上，必须先删除小写 `agents.md`，再写入
  `AGENTS.md`；反向顺序会把刚生成的 Codex 指令一并删除，场景测试必须覆盖。
- 删除模板中的 `CLAUDE.md`，更新 README 文件表和使用说明。
- 对现有 `environments/data/envs/*/project/` 做原位迁移：写入 `AGENTS.md` 后删除 `CLAUDE.md` 和小写 `agents.md`，不删除项目代码、数据库或会话状态。
- 删除无实际作用的 `daemonEnv.CLAUDECODE` 清理前，先用测试确认它不再承担嵌套进程保护；若仍有外部运行时意义，则作为有注释的负向环境隔离保留。

### 5. 清理活跃文档

- 更新根 `README.md`、`PRODUCT.md`、`PRIVACY.md`、`docs/CONTRIBUTING.md`、CLI/Server README，使安装、启动和能力描述以 Codex 为准。
- 删除 `happy claude` 使用示例；外部 App Store URL 只作为不可变链接保留。
- 删除已失效的 `docs/session-protocol-claude.md`，并从 `docs/README.md` 移除入口。
- 将 `docs/permission-resolution.md` 重写为 Codex stable-v2 的 approval/sandbox/permission resolution；不保留不存在的 Claude SDK 路径。
- 审查 `docs/api.md`、`docs/backend-architecture.md`、`docs/cli-architecture.md`、`docs/encryption.md`，区分真实保留的数据结构和已失效的 Anthropic 接入说明。
- 把 `docs/plans/` 中完全依赖 Claude SDK 的未归档计划移入 `docs/plans/archive/` 并标记 Deprecated；仍服务非 Claude provider 的 v3/ACP 计划改成 provider-neutral 表述。
- 新增 ADR-003，记录“移除主动 Claude provider、Codex 成为唯一默认”的最终决策；ADR-001 保留 Sync v4 内容，但在 status/context 中标注其 Claude-v3 范围已被 ADR-003 取代。
- 将 `packages/happy-cli/agents.md` 的有效测试分层迁到 `docs/agent-testing.md`，
  更新引用并删除其中不存在的 provider 测试路径。

### 6. 强化 Codex-only 防回归门禁

- 将 `scripts/ci/assert-no-claude-provider.cjs` 重命名为 Codex-only/provider-boundary 名称。
- 将 CI job `Claude provider removal boundary` 改为 `Codex-only provider boundary`。
- 在现有产品源码扫描基础上增加路径级检查：跟踪文件中不得出现 `CLAUDE.md`、`.claude/`、`src/claude/` 或新的 Claude Agent 配置。
- 扫描活跃 README、架构和权限文档中的 `happy claude`、Claude provider 支持声明；历史、竞品研究和 changelog 使用明确 allowlist。
- allowlist 每项必须包含文件、精确匹配和保留原因，禁止目录级宽泛豁免。
- 增加测试证明负向拒绝守卫、sandbox 依赖、Agy 模型名和 App Store URL 不会被误报。

### 7. 压缩本地记忆

- 把 `.agents/context.md` 合并为一份当前 HEAD、当前版本、最近一次有效 CI 和当前约束。
- 删除已失效的 `origin/codex/sync-v4`、App 1.11.17/1.11.18 和旧十分钟门禁状态。
- 将 `.agents/decisions.md` 中“Claude 留在 v3”等决策标记为被 2026-08-01 Codex-only 决策取代；较早完整记录移入 `.agents/archive/`。
- `.agents/open-items.md` 只保留仍需人工或物理设备完成的事项，并新增本计划的执行状态。

## 验证

### 本地源码级验证

- `git status` 不出现未解释的 Claude 配置文件。
- Codex 从项目根启动时只加载根 `AGENTS.md`；从生成的 lab-rat 项目启动时加载生成的 `AGENTS.md`。
- `/skills` 能看到唯一的 `agent-browser`、`terminal-emulator` 和新的 `i18n-translator`，不存在同名重复技能。
- 人工验收：App Web local environment action 能从 Codex desktop 启动开发服务。
- translation comparison、相关 TypeScript typecheck 和配置扫描通过。
- 新的 Codex-only boundary 脚本对允许项和故意注入的违规 fixture 都有测试。

### 云端验证

- Monorepo CI 全部通过，required aggregate 包含 Codex-only boundary。
- 官方最新稳定 Codex app-server 场景在生成的 lab-rat 项目运行，并从无凭据 Responses fixture 观察到一个仅存在于 `AGENTS.md` 的脱敏 sentinel，证明官方 Codex 实际加载了项目指令。
- CLI packaged smoke 继续证明 `happy claude` 明确失败、默认 `happy` 启动 Codex。
- Android field E2E 继续通过零 Machine、首条 Sync v4 消息、工具调用、回复、恢复和进程重启场景。
- 文档链接检查确认没有指向已删除的 Claude session/permission 文档。

## 版本、提交与发布

- 仅文档、Agent 本地配置、CI 扫描和测试夹具变化不推进 distributable 版本。
- 若实施中必须修改 CLI/App/Server/Wire/happy-agent/Codium 的运行时行为，则只推进实际受影响包的 patch 版本，并遵守已运行版本不得复用规则。
- 计划与跟踪文档使用中文提交主题；本地 `AGENTS.md`、`.agents/` 和 `.codex/` 不提交。
- 推送后等待 monorepo CI 和官方 Codex 场景；只有对应版本发生变化时才等待并交付 release artifact。

## 完成证据

- 代码验收提交为 `4825c07395af2e37751a7b41a99133aed161b897`，已正常推送到
  `origin/main`，未使用 force push。
- Monorepo CI run `30694431142` 全绿；App、CLI、Server、Wire、Codium、
  Prisma migration、Tauri、stable-v2 drift、传输故障、依赖审计、
  Codex-only provider boundary、官方 Codex app-server 生命周期和 required gate
  均通过。
- Android field E2E run `30694431146` 全绿；云端从官方最新稳定 Codex 源码解析并
  验证 app-server，生成 API 36 New Architecture x86_64 APK，随后完成真实中继鉴权和
  App 到官方 Codex 的往返场景。
- 本地源码级验证覆盖 workflow YAML、活动文档链接、Codex-only boundary 正反例、
  Responses fixture、App/官方 fixture TypeScript、10 种语言翻译比较、大小写不敏感
  lab-rat 指令生成和 `git diff --check`；未在本地构建 App、CLI、Rust、Docker、
  Android 或 Codex 发布制品。
- 本轮没有修改 distributable 运行时行为，因此保持 CLI `1.4.11`、App `1.11.19`、
  Server `1.1.32`、Wire `0.1.5`、happy-agent `0.1.1` 和 Codium `0.0.2`。
- Codex Desktop 没有公开可安全手写的 local environment schema，且自动化不能控制
  Codex 应用自身；仍需在 Desktop 设置中人工创建命令
  `pnpm --dir packages/happy-app web`、端口 `8081` 的 App Web action，并在新会话中
  确认可见和可运行。

## 完成标准

- 项目内不存在生效的 `CLAUDE.md`、`.claude/` 配置或 Claude 专用 Agent/skill。
- 所有有价值的规则已落在 Codex 原生 `AGENTS.md`、`.agents/skills` 或 `.codex` local environment 中。
- 新创建的 lab-rat 环境只包含 `AGENTS.md`，官方 Codex E2E 证明该文件被读取。
- 活跃文档不再宣称支持 Claude，历史和竞品材料有明确边界且不会影响产品路由。
- Codex-only CI 门禁能阻止 Claude provider 或 Claude Agent 配置重新进入活跃产品路径。
- Sync v4、stable-v2、最低 `0.145.0`、reasoning 和 HTTP 安全边界没有被削弱。
