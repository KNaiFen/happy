# Codex Sync v4 R9 现场故障修复计划

## 状态

- 当前状态：本地实现、审查和验证完成，待提交、推送和云端交付。
- 故障版本：CLI `1.4.6`、Server `1.1.24`、App `1.11.11`、
  Wire `0.1.3`。
- 目标版本：CLI `1.4.7`、Server `1.1.25`、App `1.11.12`；
  Wire 仅在公共 wire schema 变化时推进。
- R8 现场记录：
  `docs/plans/archive/codex-sync-v4-remediation-r8-field-acceptance.md`
- 更早实现与发布证据保留在 `docs/plans/archive/`，不在本文件重复。

## 已确认事实

1. 11:22 的普通用户会话和 root 会话均出现同一故障：发送“你好”后，
   会话列表新增记录但进入会话为空、没有回复或状态很快变为非活动。
2. Relay 对现场会话已有完整 mutation、ACK 和可重放投影；Node 环境中的
   `AppSyncV4Client` 也能拉取这些实体。
3. React Native 路径创建 `AppSyncV4Client` 时未注入安全随机源。该 client
   默认依赖 `globalThis.crypto.randomUUID/getRandomValues`，原生运行时缺失
   Web Crypto 后在能力检查之前启动失败，因此普通用户与 root 都无法投影。
4. 删除设备当前会硬删除 Machine 和 AccessKey，却没有撤销扫码产生的终端
   bearer credential，也没有持久化 Session 来源 Machine。遗留会话仍可新建
   对话，且 App 设备列表已无法再次删除它。
5. App 只把 provider child 视为只读，未识别来源设备已删除的会话；旧版
   `controlledByUser` 提示还会错误显示
   “Permissions shown in terminal only”。
6. 认证和会话边界仍有日志输出 Authorization 片段、密钥材料或完整更新
   payload 的路径，必须与功能修复一并清除。

## 实施清单

### R9.1 原生 App 同步启动

- [x] 使用 `expo-crypto` 注入 mutation UUID 和 128-bit trace ID 生成器。
- [x] 在显式删除 `globalThis.crypto` 的测试环境中启动真实 v4 client，
      覆盖 capability、拉取和本地投影入口。
- [x] 启动失败必须保持“同步未知/重试中”，不得把 execution 自动降为 idle。

### R9.2 设备凭据与会话来源

- [x] Prisma 纯新增 `TerminalAuthRequest.revokedAt`、
      `TerminalAuthRequest.credentialVersion`、`Machine.credentialId/deletedAt`
      和 `Session.originMachineId`；
      增加必要外键与索引，不删除历史数据。
- [x] 新扫码凭据同时写入稳定 `credentialId`；旧 token 的 `session` claim
      继续兼容并归一化为 credential ID。
- [x] Machine 注册时把终端 credential 绑定到唯一 Machine；Session 创建时
      显式携带并校验 `machineId`，保存来源关系。
- [x] `happy auth login` 成功后立即注册 Machine，不再等 daemon 或首个 agent
      会话启动；扫码完成后 App 的设备列表必须收到 `new-machine`。
- [x] 迁移前的 version 1 credential 只允许绑定仍存在且未删除的 Machine，
      不允许创建缺失 Machine；新扫码请求签发 version 2 credential。由此阻止
      旧版本已硬删除、无法回填 tombstone 的 root 设备凭旧 token 复活。
- [x] 删除设备改为 tombstone：停用来源会话、撤销凭据、删除 AccessKey、
      清理认证缓存并主动断开对应 socket。
- [x] 终端 token 的每次鉴权都检查撤销状态；Machine、Session 和 Sync v4
      socket/HTTP 路径校验 active Machine 与来源关系。
- [x] 扫码批准、账户登录批准和设备删除只接受 App/account token；
      terminal token 不得批准新凭据、删除设备或建立 user-scoped socket。
- [x] terminal/account QR 批准使用条件更新；两个账户并发扫码时只能有一个
      成为 owner，另一方收到冲突且不得覆盖已批准凭据。
- [x] Session 创建/恢复的 Machine 校验、来源绑定与创建使用 Serializable
      事务，同设备删除并发时不得产生新的活跃孤儿会话。
- [x] v4 请求复用终端凭据鉴权得到的活动 Machine 身份；事务内仍校验 Session
      来源关系，正常流不得通过重复 Machine/Session 查询换取安全性。
- [x] 在 HTTP、Socket 握手和每个事件处理器统一执行终端身份过滤；不得只在
      Socket 建连时授权后继续信任事件内的 `sid`/`machineId`。v1/v3
      Session、附件、AccessKey、usage、RPC 注册/调用及 Machine 心跳均不得
      跨 Machine 或跨 Session 提权。
- [x] 会话消息写入和设备删除使用可串行化事务协调；删除先提交时拒绝消息，
      消息先提交时随后删除必须成为最终状态，不留可继续执行的竞态窗口。
- [x] AccessKey create/update 的 Session、Machine 和 credential 校验必须与写入
      位于同一 Serializable 事务，设备删除提交后不得重新产生或更新密钥记录。
- [x] 对已存在但无法数据库回填的孤儿会话，允许 App 读取加密历史，
      但不允许终端凭据重连或继续执行。
- [x] Sync v4 mutation 接口对 account token 也必须在事务内拒绝来源 Machine
      缺失或已 tombstone 的会话；changes/snapshot 读取继续开放，避免只依赖
      App UI 或客户端状态实现只读。

### R9.3 App 孤儿会话只读

- [x] Session API 返回来源 Machine 和删除时间；成功加载 Machine 列表后，
      App 也以解密 metadata.machineId 缺失作为旧会话兜底判断。
- [x] 删除设备后立即将相关本地会话标为来源设备已删除并刷新列表。
- [x] 孤儿会话保留历史、详情、归档和删除；禁用发送、审批、输入请求、
      interrupt、resume、fork、goal、queue 和其他远程控制。
- [x] Codex v4 客户端在孤儿会话上仍启动、hydrate 并拉取 changes/snapshot，
      只冻结 publish 和 durable outbox flush；不得通过停止 registry client
      破坏冷启动后的历史恢复。
- [x] 显示明确的“来源设备已删除，历史只读”状态；Codex v4 不再显示旧
      terminal-only permissions 提示。
- [x] provider child 的独立只读语义保持不变，不与设备删除混用。

### R9.4 日志与错误边界

- [x] 不记录 Authorization 片段、公钥原文、private-key 派生片段、
      `dataEncryptionKey`、完整 session update 或请求 body。
- [x] 边界错误仅记录固定分类、路由和散列诊断 ID；不 stringify
      provider/Prisma 外部错误内容。
- [x] Socket、OAuth、AccessKey 和 usage 日志不得输出原始 token、Session/
      Machine ID、RPC room、加密 payload 或异常字符串。
- [x] 补充 hostile payload 测试，证明日志中不存在 token、key、prompt、
      encrypted payload 和 Prisma value。

### R9.5 验证与交付

- [x] 在空库和代表性旧库执行 migration deploy、drift、索引、回填与删除
      行为测试。
- [x] 模拟 Codex -> CLI -> HTTP relay -> 原生 App：无 Web Crypto、掉线、
      丢 invalidation、重启、设备删除竞态、旧 token 重连和历史读取。
- [x] authenticated integration seeder 必须走 terminal auth request/approval，
      不得把 App/account token 注入 daemon 来绕过 Machine credential 绑定。
- [x] 验证普通用户与 root 创建的会话均能实时显示用户消息、assistant
      回复和 execution 状态。
- [x] 验证删除设备后旧 CLI 立即失效，孤儿会话只读但可归档/删除。
- [x] 运行受影响包全量 typecheck/unit/integration、`git diff --check`、
      secret scan 和依赖审计；不运行本地 Cargo/Tauri 编译。
- [ ] 推进受影响发行版本，中文提交并推送 `origin`。
- [ ] 跟踪 GitHub Actions，修复至 required CI、CLI、Server/relay 和 Android
      工作流全部通过；下载并验证 CLI tgz，Android 仅交付 Artifact 链接。

## 本地验证证据

- App `86 files / 964 tests`、Server `24 / 156`、Wire `7 / 65`、
  Agent `9 / 227` 全绿；CLI `1107` 个单元测试全绿，authenticated daemon
  integration `11` 项全绿，依赖真实账号或 OpenClaw gateway 的项目按设计跳过。
- App、CLI、Server、Wire、Agent typecheck 全绿；Prisma schema validate、
  `git diff --check` 和本地 PGlite 全迁移链通过。
- HTTP 业务链路通过 websocket、polling、restart、snapshot 410、approval、
  child、trace、privacy、10,000+ entity、设备撤销和历史只读；20 个 5 Hz
  delta 的 p95 为 `286.6 ms`。
- 生产依赖审计为 `12 low / 91 moderate / 73 high / 0 critical`，均为既有
  依赖告警，本次未新增依赖。

## 不变约束

1. 仅 Codex 使用 Sync v4；Claude 保持 v3。
2. Codex 最低 `0.145.0`，只使用 stable-v2。
3. Web 保持 HTTPS/localhost only。
4. 原生 HTTP 只用于显式可信网络；主动 MITM 下不承诺 token、ACK、服务身份、
   metadata 或零丢失。
5. 保持端到端加密；不得记录明文 prompt、raw reasoning、工具参数、输出或密钥。
6. 只推送 `origin`；不得 force。

## 变更记录

- 2026-07-30：R8 现场验收失败并归档；确认普通用户与 root 的 v4 会话均受
  原生随机源缺失影响，活动计划切换到 R9 跨 App/CLI/Server 修复。
- 2026-07-30：安全审查发现把 Machine 删除状态并入 client eligibility 会
  同时停止历史拉取；修正为 App 仅冻结上行、Server 事务内拒绝孤儿会话
  mutation，读取链路保持可恢复。
