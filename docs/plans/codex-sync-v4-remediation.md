# Codex Sync v4 现场修复 R12

## 状态

本轮已于 2026-08-01 进入实施阶段。本文与
`remove-claude-codex-default.md` 是实现、验证与发布的唯一进度基线；发现范围或协议
假设变化时必须先更新本文，再修改业务代码。

实施进度：

- [x] 建立 Codex 默认、参数传递和负向路由防回归门禁。
- [x] 提取 CLI/provider-neutral 共享模块，解除保留 Agent 对 `claude/` 的依赖。
- [x] 完成认证状态机、MCP startup、App 投影和新会话配置修复。
- [x] 完成 Claude 主动能力删除及 Server/Wire 协调升级。
- [x] 补齐 happy-agent、Codium、发布形态和真实链路云端门禁。
- [ ] 推进协调版本，完成本地源码验证、云端 CI、发布产物与主分支同步。

### 2026-08-01 实施记录

- 已完成：CLI 认证 GET 轮询与有限退避、MCP startup canonical 过滤、App
  draft v2/Default Agent 解析、Machine 目录入口、Codex/Claude session 分类与最终
  操作门禁；对应实现分别由 `2d41239`、`d37c055f`、`379a2a9`、`6b11ea6d`
  及其后续协调提交承载。
- 已完成：CLI、App、Server、Wire、happy-agent 与 Codium 的主动 Claude 能力删除；
  保留 sandbox runtime、Gemini、OpenClaw、Agy、generic ACP 与 v3 基础设施。
- 已完成：Codium 更新为 `@openai/codex 0.146.0`，新增 macOS 云端真实 `codex exec`
  Responses fixture 生命周期门禁；happy-agent 与 CLI release workflow 现在都会安装
  生成的 tgz 做 smoke，happy-agent 额外验证 HTTP + Socket.IO 加密 spawn RPC。
- 修正：happy-agent 旧单测曾经调用残留 `dist`，会掩盖源码与发布物差异；现在本地
  单测通过 `tsx src/index.ts` 直接运行源码，云端 release workflow 单独运行已打包
  的 `dist`。同时删除了无入口但能创建无 flavor session 的 `createSession` API。
- 修正：Codium 的 one-shot child 在只发出 `error` 而没有 `close` 时曾会永久等待；
  现在 error/close 共用幂等收尾。renderer 也只在 worker `closed` 后恢复 idle，避免
  在 `turn_done -> closed` 的短窗口将下一条消息发到旧 one-shot process。
- 待完成：在同一协调版本上完成云端构建、真实 app-server/Codium runtime、tgz 与
  Android workflow 验收，随后同步 `main`。

当前发布基线：

- CLI `1.4.10`
- App `1.11.17`
- Server/relay `1.1.31`
- Wire `0.1.4`

本计划处理五个互相关联但可独立验收的问题：

1. `happy auth login` 在二维码显示后因一次瞬时连接重置直接失败。
2. MCP server 启动通知被投影成两组普通工具，且会跨过用户消息重排。
3. Machine 详情页按目录启动会话绕过 Agent 配置，固定回退到 Claude。
4. 新 Codex 会话被持久化草稿和未就绪的 capability 覆盖，未采用 Default Agent
   中配置的 model/effort。
5. 项目仍把 Claude 作为 CLI、daemon 和 App 的默认 Agent，并在 CLI、App、
   happy-agent、Codium 与云端凭据接口中保留完整 Claude 执行能力。

第五项的删除范围、历史数据边界和分阶段门禁单独落盘到
`docs/plans/remove-claude-codex-default.md`。该文件与本文件共同构成本轮权威计划；
实现时必须先建立 Codex 防回归门禁和提取共享模块，再删除 Claude 专属代码。

## 已确认根因

### 1. CLI 认证轮询把瞬时网络错误当成永久失败

`doAuth()` 先用 `POST /v1/auth/request` 创建请求，随后
`waitForAuthentication()` 不等待就再次向同一路径发送 POST。每次轮询都会执行
Server 的数据库 upsert；任意异常都被一个宽泛的 `catch` 转成固定提示并立即返回
`null`。

本机现场对比：

- 经 `127.0.0.1:7890` 代理，新建请求 `5/5` 成功，紧接的首次轮询 `5/5`
  出现 `ECONNRESET` 或 `socket hang up`。
- 绕过代理后，`10/10` 组创建与首次轮询全部返回 200。
- 原版 CLI 加入 relay `NO_PROXY` 后会持续等待扫码，不再立即退出。

Server 已有只读的 `GET /v1/auth/request/status`，App 扫码审批也已使用该接口；CLI
没有复用它。问题由代理链路的瞬时 reset 触发，但 CLI 的立即重复 POST、无重试和
错误吞没使其稳定表现为登录失败。

```txt
happy auth login
│
├─ doAuth()
│  └─ POST /v1/auth/request              -> requested
│
└─ waitForAuthentication()
   └─ 立即 POST /v1/auth/request         -> ECONNRESET
      └─ catch                           -> return null（不重试、隐藏错误码）
```

### 2. MCP startup 被错误建模为 turn 工具

2026-08-01 的脱敏 RPC trace 证实，官方 app-server 在首个 turn 中按以下顺序发出
通知：

- `thread/start` 返回后、`turn/started` 前，对 5 个 MCP server 发出 25 条
  `mcpServer/startupStatus/updated`。
- `turn/started` 后，再对相同 5 个 server 发出 5 条状态通知。
- 首个 turn 在约 9.5 秒时权威完成。

`CodexSyncV4Mapper.applyMcpStartup()` 在没有 active turn 时把这些通知挂到
`__runtime_events__`，有 active turn 时又挂到真实 turn。entity provider ID 包含
turn ID，因此同一 MCP server 会成为两套实体。App 的 `projectTool()` 没有
`mcpStartup` 专用分支，含 `mcpProgress` part 的实体落入通用工具分支并显示为
`startup`。

```txt
mcpServer/startupStatus/updated
│
└─ CodexSyncV4Mapper.applyMcpStartup()
   ├─ activeTurn 不存在 -> turnId = "__runtime_events__"
   │  └─ codex.item(..., "__mcp_startup__<name>", "mcpStartup")
   └─ activeTurn 存在   -> turnId = 官方 turnId
      └─ 另一套 codex.item(..., "__mcp_startup__<name>", "mcpStartup")

CodexV4Projection.projectTool()
└─ 通用 content fallback -> ToolCall(name = "startup")
   └─ groupMessagesForDisplay() -> “使用了 5 个工具”
```

用户消息的位置变化来自第二个已确认的投影动作：最初显示本地
`codex.command`；官方 `userMessage.clientId` 到达后，App 隐藏 command 并用官方
item 替换它。官方 item 的时间和 turn-local sequence 不同，先前的 runtime startup
组于是从用户消息下方重排到上方；真实 turn 内的 startup 组仍位于用户消息下方。
turn 完成后，当前 turn 的工具被 `AgentWorkGroupItem` 折叠，所以第二组消失，只剩
runtime 组。

MCP server startup 是 thread/runtime 生命周期，不是模型调用的工具。真正应该显示
在聊天中的实体是官方 `mcpToolCall` 及其 `item/mcpToolCall/progress`。

### 3. Machine 详情页绕过统一新会话配置

`MachineDetailScreen.handleStartSession()` 直接调用 `machineSpawnNewSession()`，只传
`machineId`、目录和目录创建授权，没有传 `agent`、`permissionMode`、`modelMode`
或 `effortLevel`。CLI daemon 对缺失的 `agent` 明确回退到 Claude。

该入口也没有 Agent 选择控件，并且重复实现了目录创建、刷新和导航逻辑，所以
Settings -> Devices -> Machine -> Start in directory 无法创建 Codex 会话不是偶发
状态，而是当前代码的固定行为。

### 4. 持久化草稿覆盖 Default Agent，并在 capability 未就绪时破坏 `max`

`new-session-draft-v1` 用一套全局字段持久化上次的 permission/model/effort，未按
Agent 或模型分区，也没有记录值是“跟随默认”还是“本次显式覆盖”。三个创建入口的
解析优先级均把 draft 放在 Default Agent 之前，因此旧 `low/medium` 永远覆盖后来
设置的 `max`。

此外，Codex capability 尚未到达时的硬编码 effort fallback 不包含 `max`。新会话
页面发现 draft 中的 `max` 暂时不在 options 后，会立刻把持久化 draft 改成模型
默认或第一个选项。capability 稍后到达也无法恢复，因为刚写入的 `low/medium` 又
拥有最高优先级。

现场 CLI 日志与该链路一致：App 创建的 Codex 进程实际收到
`--model gpt-5.6-sol --effort medium`，CLI 没有自行把 `max` 改成 `medium`。

```txt
Agent Defaults: codex.effortLevel = "max"
│
├─ new-session-draft-v1.effortLevel = "medium"（历史值）
│  └─ draft > defaults             -> 选择 medium
│
└─ capability 暂未加载
   ├─ fallback options 无 max
   └─ setEffortLevel(model default / first option)
      └─ 把临时判断永久写回 MMKV
```

## 修复计划

### 1. 重写 CLI 终端认证状态机

- `POST /v1/auth/request` 只用于创建请求和授权完成后的凭据领取，不再按秒 upsert。
- QR 显示后先等待一个轮询间隔，再用 `GET /v1/auth/request/status?publicKey=...`
  等待 `pending -> authorized`。
- 状态变为 `authorized` 后执行一次领取 POST；领取结果不明确时可按相同幂等公钥
  重试，但不能生成新的 keypair 或认证记录。
- 对 `ECONNRESET`、`ETIMEDOUT`、`EPIPE`、HTTP 408/429/5xx 使用最多 5 次连续
  full-jitter 退避；任一成功状态检查会清零连续失败计数。
- 401/403/404/410、响应 schema 错误和解密失败立即终止，不把永久错误伪装成
  “仍在等待”。429 优先遵守合法且有上限的 `Retry-After`。
- 普通输出只显示可操作的固定文案；DEBUG/结构化日志只记录错误 code、HTTP status、
  attempt 和阶段，不记录公钥、QR URL、token、加密 response 或完整请求 URL。
- 把轮询与凭据解析拆成可测试函数，`SIGINT` 必须在等待、退避和领取阶段都能退出，
  并始终移除 listener。

Server 已有足够接口，本项默认只修改 CLI；若实现时发现 GET/POST 的状态存在协议
缺口，必须先修订本计划再改 Server，不能静默扩展响应。

### 2. 从聊天 canonical model 中移除 MCP startup

- CLI 继续把 `mcpServer/startupStatus/updated` 识别为已知 stable-v2 方法，保留
  有界、脱敏的本地诊断和方法覆盖率，但不再创建 `codex.item` 或 `codex.part`，也
  不再猜测它属于 active turn。
- App 投影显式忽略历史 `itemType=mcpStartup`，使 Server snapshot 中已经存在的旧
  实体立即停止显示；不删除 relay 数据、不生成跨设备 tombstone。
- 真正的 `mcpToolCall`、`mcpProgress`、审批与错误保持原行为，仍按官方
  `(threadId, turnId, itemId, eventSequence)` 更新同一个工具卡。
- Codex v4 当前 turn 是否可折叠改由 canonical active turn/request 状态决定，不再
  依赖旧 `session.thinking` 布尔值，避免 v3 状态晚到使工具组提前折叠。
- 保持用户 command 被官方 `UserMessage.clientId` 替换的幂等逻辑，但增加完整阶段
  顺序测试，确保替换不会让任何可见的非 turn runtime 项跨过用户消息。

本项不新增 Wire 字段：startup failure 暂保留在本地诊断，不能为了显示运行时遥测
继续伪造成模型工具。若未来需要远程 MCP server 状态，应单独设计 runtime schema。

### 3. 统一新会话配置解析并迁移 draft

- 将 draft mode 字段定义为“本次新会话显式覆盖”，`null` 表示跟随 Settings 中的
  Default Agent；Default Agent 是新会话的权威基线。
- 升级为 `new-session-draft-v2`。首次读取 v1 时保留 prompt、Machine、目录、Agent、
  worktree 等环境信息，但清空无法判断来源的 permission/model/effort 旧值，避免
  历史 `low/medium` 继续污染新会话。
- 用户在 composer 中选择与默认值相同的选项时保存 `null`；选择不同值时才保存
  override。会话成功创建后清空三个 mode override，但保留 Machine、目录和 Agent。
- 切换 Agent 时原子清空 mode override，让目标 Agent 立即使用自己的默认值；不让
  Claude 的 model/effort 穿透到 Codex。
- 提取唯一的纯函数 `resolveNewSessionAgentConfig()`，由 Home dock、完整 New screen
  和实际 spawn hook 共用，删除三套不同的优先级和 fallback 实现。
- capability 缺失或仍在加载时视为“未知”，不得把当前选择判为不支持，更不得写回
  MMKV；UI 临时保留并显示已配置 key。
- 只有 Machine 返回权威的目标模型 capability 后，才能修复真正不支持的 effort；
  fallback 顺序固定为模型官方默认、Agent 默认、首个官方支持值，并在发送前再次
  通过同一纯函数校验。
- 创建 RPC 和随后首条 `codex.command` 必须携带同一份 model/effort，避免会话启动
  是 `max`、首条 turn 又被旧消息 metadata 改回其他值。

### 4. Machine 详情页进入统一 Agent 创建流程

- 删除 Machine 详情页对 `machineSpawnNewSession()` 的直接调用。
- 新增一个原子 draft preparation 动作，写入当前 Machine 与用户输入目录后导航到
  `/new`；统一页面提供 Agent、model、effort、permission 和 worktree 选择。
- 该动作不得覆盖用户上次选择的 Agent，也不得带入旧 mode override；进入页面时
  显示该 Agent 的当前 Default Agent 配置。用户可以在提交前明确切换到 Codex。
- 目录不存在审批、spawn、刷新、首条消息和错误处理全部复用统一创建路径，避免
  Machine 页再次形成独立行为。
- 调整入口文案为“继续创建新对话”语义，避免用户以为点击后已用不可见的默认 Agent
  立即启动。

### 5. 移除 Claude 主动兼容并切换 Codex 默认

- 按 `docs/plans/remove-claude-codex-default.md` 分阶段执行，不在本文件重复展开删除
  清单。
- 裸 `happy`、daemon 缺省 spawn、App 首次 draft 和 happy-agent 缺省 Agent 全部改为
  Codex；`happy codex` 继续作为显式别名。
- 删除 Claude 的启动、resume/fork/rewind、OAuth/connect、模型/权限 UI、Claude
  Agent SDK 和 Codium Anthropic plugin，但先把 Codex 仍使用的 session server、kill
  handler、schema 和 sandbox 能力迁出 `claude/` 命名空间。
- 用户已确认没有需保留的旧 Claude 对话，因此不实现 Claude 历史迁移、只读展示或
  resume。没有显式 Codex 标记的记录按 unsupported 排除，绝不能默认解释为 Codex。
- Gemini、OpenClaw、Agy 和 generic ACP 默认不属于本次删除范围；
  `@anthropic-ai/sandbox-runtime` 因被 Codex sandbox 直接使用而保留，它不是 Claude
  provider 兼容入口。

## 测试与验收

### 本地源码级验证

按项目约束只运行直接 Vitest/tsx 与 `tsc --noEmit`，不在本地 build App、CLI、Web、
Rust、Docker 或 Codex：

- CLI auth 状态机：pending、authorized、领取、首次 reset 后恢复、连续失败上限、
  429 Retry-After、永久 4xx、取消和日志脱敏。
- Mapper：复放“5 个 server、turn 前 25 条、turn 后 5 条”的官方方法序列，断言
  unknown method 为 0 且不会产生 `mcpStartup` item/part。
- App projection/grouping：从 command、官方 user item、真实 MCP call、thinking、
  final answer 逐步应用 entity，逐阶段断言稳定 ID、视觉顺序和零重复。
- 历史 snapshot：旧 `mcpStartup` entity 保留在 cache，但投影消息为 0。
- Draft v1 -> v2：保留 prompt/目录/Agent，清空旧 mode；默认 `max`、capability 晚到、
  权威不支持、Agent 切换和成功后 reset 均有确定结果。
- Machine 入口：断言只预填 Machine/目录并导航，不直接 RPC；最终 Codex spawn 精确
  携带设置中的 model 和 `max`。

### 云端构建与真实链路

- Monorepo CI 运行完整 CLI/App/Server/Wire 测试、类型检查、production build、Web
  export、Tauri/Cargo、stable-v2 drift 和 required aggregate gate。
- HTTP fault harness 启动真实 relay 与一个会主动 reset 首次 status/claim 连接的代理，
  用发布形态 CLI auth client 完成创建、等待、审批和凭据领取；不得只 mock Axios。
- 官方 Codex app-server gate 配置 5 个本地 MCP fixture，复现 startup 通知发生在
  turn 前后；另触发一个真实 `mcpToolCall/progress`，证明只有后者进入聊天投影。
- Android API 36 field 场景通过 UI 把 Codex Default Agent 设置为目标 model + `max`，
  从 Settings -> Devices -> Machine -> directory 进入统一创建页，选择 Codex 并发送
  首条消息。安全报告校验 daemon spawn 收到 `agent=codex` 和 `effort=max`。
- Android 场景在官方 user item 替换本地 command 前后截图/断言：用户消息保持原位，
  startup 工具摘要为 0，真实 MCP 工具摘要最多 1，thinking 与最终回复顺序稳定；杀
  进程恢复后结果一致。

## 版本、发布与回滚

实现完成后预计推进：

- CLI `1.4.10 -> 1.4.11`：认证状态机和 MCP startup mapper。
- App `1.11.17 -> 1.11.18`：历史 startup 过滤、canonical turn 分组、新会话配置与
  Machine 入口。
- Server `1.1.31 -> 1.1.32`：关闭 Anthropic vendor 新接入并提升协调版本。
- happy-agent `0.1.0 -> 0.1.1`：移除 Claude Agent 并把缺省 spawn 改为 Codex。
- 私有 Codium `0.0.1 -> 0.0.2`：删除 Claude worker/plugin/dependencies，保留并验证
  Codex runner。
- Wire `0.1.4 -> 0.1.5`：协调删除 Claude history/capability 主动字段；Server 不为
  可能存在的未知 JSON 键执行破坏性数据库清理。

提交前必须确认没有 AI 本地文件被暂存。代码、版本和计划使用中文主题提交，推送
`origin` 后等待全部云端检查；CLI workflow 成功后下载并校验单一 npm tgz，Android
只提供 Artifact URL。任一已启动 release workflow 的版本不得复用。

回滚时可恢复旧 CLI/App 代码，但不需要删除 Server 数据。App 对历史 `mcpStartup`
的过滤是纯投影行为；draft v2 不回写或删除 v1 key，回滚版本仍可读取原 v1 数据。

## 非目标

- 不删除被其他 Agent 与既有非 Claude 数据复用的 v3 transport/data schema；Claude
  主动执行与 history projection 按配套计划移除。Web HTTPS/localhost policy、可信
  网络 HTTP 风险声明和 Sync v4 外层加密协议保持不变。
- 不隐藏真正的 MCP tool call、命令、patch、审批、reasoning summary 或错误。
- 不修改官方 stable-v2 schema，不启用 experimental 方法，不降低 Codex 最低版本。
- 不在日志、测试 artifact 或 CI 输出中记录 prompt、工具参数、公钥、QR URL、token、
  加密 response 或密钥。
- 不删除 Gemini、OpenClaw、Agy 或 generic ACP；不因包名包含 Anthropic 而移除 Codex
  仍依赖的 sandbox runtime。

## 完成标准

- 一次或少量瞬时 `ECONNRESET` 不会终止扫码登录；连续永久失败给出脱敏且可操作的
  失败原因。
- MCP server startup 永远不显示为“使用了 N 个工具”，已有历史会话刷新后也不显示。
- 本地 command 被官方 user item 替换时，用户消息和真实工具不会跨 turn 重排或
  重复。
- Machine 详情页可以进入并明确选择 Codex，不能再无提示创建 Claude。
- Default Agent 设置为 `max` 后，capability 冷启动、App 重启和新会话入口均向 CLI
  发送 `max`；只有权威模型列表明确不支持时才执行确定性 fallback。
- 裸 `happy`、App 首次进入、Machine 缺省 spawn 和 happy-agent 缺省 spawn 都启动
  Codex；所有主动 Claude 启动、连接、resume 和 fork 入口均不存在或明确拒绝。
- CLI 与 Codium 的发布依赖树不含 Claude Agent SDK 或 Anthropic API SDK；Codex
  sandbox、app-server、Sync v4 和实际工具调用验收全部保持通过。
- 本地源码测试与同一提交的 monorepo CI、官方 app-server gate、HTTP auth fault
  harness 和 Android field 场景全部通过。
