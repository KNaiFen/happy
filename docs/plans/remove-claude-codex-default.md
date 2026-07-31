# 移除 Claude 兼容并切换 Codex 默认计划

## 状态与目标

本文件是 `codex-sync-v4-remediation.md` 的权威子计划，已于 2026-08-01 进入实施。
删除工作必须按“防回归门禁 -> 共享模块迁出 -> 分包删除 -> 静态残留审计”的顺序
推进；每个阶段完成后在主计划勾选并留下对应提交。

目标是移除项目中所有“主动 Claude provider 能力”：不能新建、启动、恢复、fork、
rewind、授权、连接或配置 Claude；所有未指定 Agent 的新操作使用 Codex。同时必须
保持 Codex stable-v2、Sync v4、sandbox、MCP、审批、子线程、历史恢复和发布链路
完整可用。

### 2026-08-01 实施记录

本计划的代码删除与本地源码验证已完成，云端验收与发布仍待执行：

- CLI 的裸入口和 daemon omitted-agent 路径已显式选择 Codex；旧命令、旧 agent 与
  旧 provider 参数均在认证或 spawn 前确定性拒绝。
- App 已移除 Claude 创建、OAuth、历史 projection 与错误 fallback；空/未知/Claude
  metadata 不会被升级成 Codex v4，也不会进入可操作会话列表。
- Server 拒绝新的 Anthropic credential 接入；Wire、App 和 CLI 删除 Claude session
  主动字段，旧未知加密键只会忽略而不会重新发布。
- happy-agent 只保留 Codex、Gemini、OpenClaw、Agy；无 `create` 命令或内部
  `createSession` API，避免制造无 flavor session。其本地 CLI 测试直接运行源码，
  release workflow 则安装 tgz 并完成加密 HTTP + Socket.IO spawn 场景。
- Codium 删除 Claude SDK worker 与 Anthropic plugin，保留 Codex one-shot runner；
  云端 macOS 门禁将以 `@openai/codex 0.146.0` 实际运行工具 follow-up 与最终输出。
  runner 在 spawn error/close 与 renderer turn-close 的竞态均有独立回归覆盖。
- 首轮 macOS 门禁还暴露出官方 `0.146.0` 平台包的 `bin/codex`、`codex-path` 布局；
  runner 将以存在性检测同时支持该布局和旧版 `codex/codex`、`path` 布局，不能因
  npm 包内部重排而回退或失去 Codex 执行能力。其超时诊断只允许输出协议阶段元数据，
  不允许在 CI 日志泄露 prompt、响应或工具参数。测试用临时目录将初始化为 Git
  仓库，以符合官方非交互执行前置条件且不改变 Codium 的产品安全边界。
- `.agents` 外的五个本地 Claude-first 指令文件已按用户授权删除，未纳入 Git。

待完成：版本 `CLI 1.4.11`、`App 1.11.18`、`Server 1.1.32`、`Wire 0.1.5`、
`happy-agent 0.1.1` 与 `Codium 0.0.2` 的云端门禁、产物与 `main` 同步。

## 范围定义

“移除 Claude 兼容”包括：

- CLI 不再运行或代理 Claude Code，不再接受 Claude 专属参数。
- daemon、App、happy-agent 与 Codium 不再把 Claude 作为可创建 Agent。
- App 不再展示 Claude connect、模型、effort、权限、fork/rewind 或 provider UI。
- Server 不再接受新的 Anthropic vendor credential 注册或读取。
- CLI/Codium 不再依赖 Claude Agent SDK 或 Anthropic API SDK。

以下内容不应被误删：

- Codex 直接使用的 `@anthropic-ai/sandbox-runtime`。它是共享 sandbox 实现，不是
  Claude provider 入口；替换它需要单独的安全迁移计划。
- v3 session/message、Socket.IO、Machine RPC、push、附件和通用 permission UI 中
  被其他 Agent 复用的基础设施。
- App Store 已发布页面中不可变的 URL slug，即使其中含 `claude-code-client`。

Gemini、OpenClaw、Agy 和 generic ACP 不在本轮删除范围。

## 已确认的数据策略

用户确认当前没有需要保留的旧 Claude 对话。本轮不实现 Claude 历史迁移、只读展示、
归档恢复或兼容入口；从主动类型、投影和 UI 中删除 `claudeUuid`、`claudeSessionId` 与
Claude history parser。Server 的加密/JSON 数据不做无必要的破坏性清库；若异常遇到
旧键，只作为不受支持的 opaque 数据忽略，不重新发布给 App。

`flavor=null` 或 `flavor=claude` 仍不能转换为 Codex。这不是旧历史兼容，而是防止错误
路由到 Codex v4 的负向安全边界。Codex 可写资格继续严格要求：

```txt
metadata.flavor === "codex"
└─ metadata.codexSyncVersion === 4
   └─ 才允许发布 codex.command / control mutation

其他 metadata
└─ unsupported/other
   └─ 永远不能走 Codex v4 写路径
```

## 当前依赖图与风险

### CLI

- 裸 `happy` 在 `src/index.ts` 解析 Claude flags 并调用 `runClaude()`。
- `happy codex` 已有独立 `handleCodexCommand()`，但帮助、默认入口和部分 resume 仍以
  Claude 为中心。
- daemon 对 `agent === undefined` 和 `agent === 'claude'` 都选择 Claude；tmux 分支也
  用嵌套三元表达式回退 Claude。
- `src/claude/` 包含完整 SDK/local/remote/scanner/fork/permission 实现，但其中
  `registerKillSessionHandler` 和 `startHappyServer` 被 Codex、Gemini、Agy、OpenClaw
  与 ACP 复用，不能随目录直接删除。
- `apiSession.ts`、`apiMachine.ts`、resume 与共享 types 仍包含 Claude transcript 和
  fork RPC。
- `@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk` 是 Claude 专属；
  `@anthropic-ai/sandbox-runtime` 同时是 Codex 专属安全依赖。

### App

- `agentKeys`、Home dock 和 New screen 都把 Claude 放在 Agent 列表首位；draft 无值
  时默认 `claude`。
- `normalizeAgentKey()` 把未知 flavor 统一回退 Claude；Avatar、Session info 和消息
  解析也把空 flavor 当 Claude。
- Settings 仍有 Claude OAuth/connect、Agent Defaults、Anthropic connected service
  和 Claude icon。
- Duplicate/rewind、permission footer、goal、voice/context 文案与 attachment support
  含 Claude 专用分支。
- 直接把所有空 flavor 改为 Codex 会把 unsupported/unknown 记录错误升级为可写 Codex，
  即使当前没有 Claude 历史，也会破坏 v4 ownership 边界。

### happy-agent

- `SupportedAgent` 和 CLI option 包含 Claude；`--agent` 省略时把 `undefined` 交给
  daemon，最终回退 Claude。

### Codium

- 私有 Electron 包同时内置 `AgentEngine='codex'|'claude'`、Claude Agent SDK worker、
  Anthropic plugin/API key、Claude 模型目录和三个 Anthropic 依赖。
- Codex 分支与 Claude 分支共用 worker protocol；删除前必须先锁定 Codex exec 参数、
  进程中断、输出读取和错误语义。
- Codium 当前不在 monorepo required CI 中，是删除后影响 Codex而无人发现的风险。

### Server 与 Wire

- Server provider runtime 基本无 Claude 实现，但 connect routes 仍允许
  `vendor=anthropic`；v1 shutdown 和 v3 transport 被其他 Agent/既有数据共享。
- Wire 的 `claudeUuid` 是当前 session protocol 的可选顺序/rewind 元数据。无需为旧
  Claude 数据保留它，但必须协调 Wire、CLI、App 同一版本删除，避免半升级解析失败。

## 实施顺序

### 0. 先建立 Codex 防回归基线

- 为裸 `happy` 与 `happy codex` 提取同一 Codex option parser，并先用测试固定
  model、effort、permission、resume、sandbox 和退出码语义。
- 固定 daemon regular/tmux 两条 spawn 路径：缺省 Agent 必须解析为 Codex，显式
  Codex 参数必须逐字进入 child argv。
- 固定 App 与 happy-agent 的 spawn payload；缺省与显式 Codex 均必须带
  `agent=codex`，不能依赖接收端 fallback。
- 固定安全边界：只有显式 Codex v4 metadata 可写，unsupported/other 全部拒绝。
- 为 Codium Codex worker 增加 golden tests，覆盖 executable resolution、exec args、
  stdout drain、last-message、SIGINT、非零退出和临时目录清理。

任何删除提交都必须建立在这些测试已经通过的提交之上。

### 1. 先把共享代码迁出 `claude/`

- 将 `registerKillSessionHandler` 移到通用 RPC 模块，将 `startHappyServer` 移到通用
  session server 模块，更新 Codex/Gemini/Agy/OpenClaw/ACP imports。
- 将仍被通用 API 使用的 usage/envelope schema 移到 provider-neutral 文件；只保留
  其他 Agent 真正依赖的字段和行为。
- 拆开 `apiSession.ts` 的通用发送/附件逻辑与 Claude transcript side effects。Codex
  v4 不得继续通过 Claude mapper 或 `RawJSONLines` 类型间接工作。
- 增加静态边界测试：`src/codex`、`src/agent`、Gemini、Agy、OpenClaw 不得 import
  `@/claude`；共享模块不得 import Claude SDK。

完成该阶段后再删除 `src/claude/`，避免用复制粘贴重建共享能力。

### 2. CLI 与 daemon 改成 Codex 默认

- 裸 `happy [codex-options]` 直接调用与 `happy codex` 相同的 handler；后者继续保留
  为显式、向后兼容的别名。
- 重写 help/description/examples，不执行 `claude --help`，不再透传未知 Claude
  flags；旧 `--claude-env`、`--chrome`、`--js-runtime` 等返回明确的已移除提示。
- 删除 `runClaude`、local/remote launcher、SDK wrapper、session scanner、Claude
  permissions、hooks、fork/rewind 和对应 fixtures/tests。
- 删除 `happy connect claude`、`authenticateClaude` 和 Anthropic status 项。
- `SpawnSessionOptions.agent` 不再包含 Claude；regular 与 tmux 的 undefined fallback
  都显式设为 Codex。收到 `agent=claude` 必须返回可操作的“不再支持”错误，不能静默
  回退 Codex或其他 Agent。
- 删除 Claude resume/fork/list-rewind/truncate Machine RPC、resume resolver 和本地
  transcript store，不提供历史 Claude 只读启动路径。
- 从协调后的 CLI/App Machine capability schema 中删除 `cliAvailability.claude`；旧 App
  不在本轮强制升级边界内继续兼容。新的选择逻辑只读取 Codex/其他保留 Agent。
- 从 CLI package 与 lockfile 删除 Claude Agent SDK 和 Anthropic API SDK；保留并测试
  sandbox runtime，因为 Codex app-server 仍调用它。

### 3. App 移除 Claude UI 与错误默认

- 从可创建 `AgentKey`、pickers、Agent Defaults 和 capability 过滤中删除 Claude；新
  draft 与 v1/v2 migration 默认 Agent 设为 Codex。
- 分离 `resolveNewSessionAgent()` 与 `classifyExistingSessionFlavor()`：前者缺省 Codex，
  后者对空/Claude metadata 返回 unsupported 并从产品列表排除，绝不共用 fallback。
- Machine 页面统一进入 New composer；Home、空首页、New screen 和快捷创建都显示
  Codex 为首选并显式发送 `agent=codex`。
- 删除 Claude Settings connect/OAuth、Anthropic service 状态、Claude model/effort/
  permission options、fork/rewind RPC 和 Claude 专用审批按钮。
- 将 voice/context/notification 中面向多 Agent 的 “Claude Code” 文案改为 “Codex”
  或 provider-neutral 文案；不能把 Gemini/Agy 事件错误称作 Codex。
- 删除 Claude history projection、resume command、duplicate/rewind、详情字段、logo 和
  翻译；异常出现的 Claude/unknown session 不进入产品列表，最终 operation 边界仍拒绝。
- `attachmentSupport`、Avatar、Session info、MessageView 和 quick actions 不再把空
  flavor 当成 Claude或 Codex。

### 4. happy-agent 改成 Codex 默认

- 从 `SupportedAgent` 与 `--agent` choices 删除 Claude。
- 省略 `--agent` 时在 happy-agent 侧显式写入 `codex`，不能继续依赖 daemon fallback。
- 对显式 `--agent claude` 返回清晰错误；status/JSON 输出中的 default 显示 Codex。
- 保留其他 Agent choices，不改变认证、Machine 解析和 session client。
- 新增 `build-happy-agent-release.yml`：只在 `packages/happy-agent/package.json` 的版本变化
  时运行源码测试、类型检查、`pnpm pack` 和安装后 smoke，并上传单一可安装 tgz。
- 工作流必须检查 tgz 的版本、入口、依赖树和 source commit，并从发布包实际执行缺省
  Codex spawn 与显式 Claude 拒绝场景；不能只测试 workspace 源码。
- 云端发布链路稳定后删除 package 内本地 `release-it` script/dependency，避免开发机绕过
  Actions 生成或发布未经门禁的产物。若没有 npm registry 发布凭据，工作流只生成可验证
  artifact，不凭空扩大为公开发布。

### 5. Codium 删除 Claude worker 与 Anthropic plugin

- 将 worker protocol 和 catalog 收窄为 Codex；先保留 Codex branch原行为，再删除
  `ClaudeSessionState`、stream input、SDK consume 与 Claude executable resolution。
- 删除 Anthropic plugin、API key storage/UI、Claude models 和所有 Claude selector。
- 从 package/lockfile 删除 Claude Agent SDK、Claude Code 与 Anthropic SDK；保留
  `@openai/codex` 与 Codex OAuth。
- 将 Codium 加入 monorepo path filter、typecheck、unit test 和 production build CI；
  在云端验证 Codex binary resolution 与 one-shot turn，避免私有包继续无门禁漂移。
- 本轮不顺便把 Codium one-shot `codex exec` 重构成 Happy stable-v2 app-server；那是
  独立架构工作，避免把“移除 Claude”变成 Codium runtime 重写。

### 6. Server、Wire 与数据兼容

- connect routes 不再接受 `anthropic` 注册/读取，App/CLI 同时移除入口；已有加密
  vendor token 行保留但不可使用，不做破坏性数据库 migration。
- v3 session/message/shutdown endpoints 继续服务其他 Agent 和既有数据；只移除错误
  的 Claude 专属注释/分支，不以名称为理由删除共享协议。
- 从 Wire、CLI 和 App 的主动 session protocol/types 删除 `claudeUuid`、
  `claudeSessionId`、Claude fork/rewind payload 与 capability 字段；Server 对 JSON 中
  未知旧键保持忽略，不为其增加 importer、projection 或数据库清理 migration。
- 协调更新所有生产者和消费者，不提升 schema major；Wire 推进 patch 版本并用
  forbidden-symbol gate 防止 Claude history 字段重新进入主动协议。
- Server 提升 Codex v4 最低 App/CLI 版本，确保旧默认-Claude客户端不能继续参与本轮
  Codex协调；数据库变更预计为零。

### 7. 清理本地 Claude-first Agent 准则

用户已明确允许删除项目工作区中限制 Claude 改动或仍把 Happy 描述为 Claude wrapper
的本地 Agent 指令。下列文件均被 `.git/info/exclude` 排除，不属于发布代码，也不得
进入提交：

- `packages/happy-cli/CLAUDE.md`
- `packages/happy-cli/src/daemon/CLAUDE.md`
- `packages/happy-app/CLAUDE.md`
- `packages/happy-server/CLAUDE.md`
- `packages/happy-server/deploy/integration-tests/CLAUDE.md`

实施启动时先把其中仍正确且 provider-neutral 的约束与现行 `AGENTS.md`、`dev` skill
对照；只迁移尚未被覆盖的工程规则，例如 App 翻译/Modal 约定和 Server transaction
边界。随后删除上述 Claude-first 文件，旧的“Claude 保持 v3”决策明确标记为已被
本计划取代，不能继续阻止 Claude provider 删除。

不删除 `.agents/skills/sessions` 中对旧 Claude Code 会话日志的只读解析能力；它是本地
历史检索工具，不是 Happy 产品的 Claude 兼容入口。`environments/**/CLAUDE.md` 是生成
环境的指令转发文件，也不在未确认用途前批量删除。`.claude/settings.json` 等本地工具
配置不包含本次识别到的 Claude provider 保留规则，默认不动。

## 测试计划

### 本地源码级

- 只运行直接 Vitest/tsx 与 `tsc --noEmit`，不本地构建发布产物。
- Codex protected surface：bare/explicit CLI、daemon regular/tmux、resume、sandbox、
  MCP、approval、Sync v4、child sessions 和 shutdown。
- 负向 Claude surface：CLI subcommand/flags、Machine RPC、App picker、happy-agent、
  Codium catalog 与 vendor API 均不存在或明确拒绝。
- Session classification 矩阵：explicit Codex v4、Codex without v4、Claude、empty、
  Gemini/OpenClaw/Agy；只有第一项可写 v4。
- Draft migration：旧 `agentType=claude` 变为 Codex并清空 provider modes，不丢 prompt、
  Machine、path、worktree 或附件内存状态。
- 依赖边界：Codex与其他保留 Agent无 `@/claude` import；SDK forbidden-import gate
  允许 `@anthropic-ai/sandbox-runtime` 且仅允许 sandbox 模块引用。
- 本地指令审计：上述 package 级 `CLAUDE.md` 全部不存在；现行 `AGENTS.md`/skill 不再
  含有要求保留主动 Claude provider 的规则，同时 provider-neutral 工程约束仍可追溯。

### 云端真实场景

- 完整 monorepo CI 加入 Codium，并继续执行 CLI/App/Agent/Server/Wire、Web export、
  Tauri/Cargo、Android、official app-server 和 aggregate gate。
- `happy-agent` 使用独立 version-gated release workflow，从云端生成并安装校验 tgz；
  required aggregate gate 必须等待它的 source checks，release workflow 负责发布形态验证。
- 从发布形态 npm tgz 安装后运行裸 `happy`，验证它启动官方 Codex app-server 并完成
  thread start、turn、真实 shell/MCP progress、final answer 与恢复；`happy codex`
  运行相同场景。
- daemon 收到省略 agent 的旧式 spawn payload 时也必须创建 Codex v4；另用显式
  `agent=claude` 验证确定性拒绝，不启动任何 provider child。
- Android API 36 从零状态只看到 Codex默认入口；Machine directory、Home dock 和
  New screen 各创建一次 Codex，均验证 model/effort、首条消息、工具顺序和进程恢复。
- Codium cloud build 运行 Codex worker smoke；CLI tgz/Codium dependency tree 断言不含
  Claude Agent SDK、Claude Code 或 Anthropic API SDK。
- 运行静态残留审计，产品源码只允许明确拒绝旧 `agent=claude` 的负向测试/错误、
  external App Store URL 和 sandbox runtime allowlist 包含 Claude/Anthropic 标识；
  每项必须有原因，history schema 不在 allowlist。

## 发布与版本

若与 R12 其他修复在同一协调版本交付：

- CLI `1.4.10 -> 1.4.11`
- App `1.11.17 -> 1.11.18`
- Server `1.1.31 -> 1.1.32`
- happy-agent `0.1.0 -> 0.1.1`
- private Codium `0.0.1 -> 0.0.2`
- Wire `0.1.4 -> 0.1.5`

先部署可识别新版本的 Server，再发布匹配 App/CLI/happy-agent；CLI 与 happy-agent
分别由各自的 version-gated Actions 生成安装包。用户已确认没有需保留的旧 Claude
会话；发布前仍检查没有正在运行的 Claude child process，避免升级中途遗留孤儿进程。
不存在长期双栈、Claude fallback 或历史展示层。

所有 release build 留在 GitHub Actions。本地只做源码测试；云端成功后按项目规则
下载并验证 CLI tgz，Android 只提供 Artifact URL。任何已启动 workflow 的版本不可
复用。

## 完成标准

- `happy` 与 `happy codex` 启动同一 Codex stable-v2 路径；所有缺省新建入口显式
  产生 Codex v4 session。
- 没有 UI、CLI、Machine RPC、happy-agent 或 Codium入口能够启动/连接 Claude。
- Claude Agent SDK、Claude Code 和 Anthropic API SDK 不在 CLI/Codium 发布依赖树；
  Codex sandbox runtime 保留且回归通过。
- Claude/未知 metadata 永远不会被分类为 Codex，也不会进入产品会话列表或获得写入口。
- 其他保留 Agent 的共享 v3 基础设施未被误删。
- 所有 Codex单元、传输、官方 app-server、Android、Codium和发布包门禁在同一提交
  全绿。
