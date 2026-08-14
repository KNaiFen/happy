# Happy Server 架构

> **当前文档（2026-08-05）：** 本文描述 `packages/happy-server` 的现行边界。
> Codex 同步以 [ADR-001](decisions/ADR-001-codex-sync-v4.md) 为权威来源。

## 职责与安全边界

Happy Server 是认证、加密数据中继、同步日志、设备/会话目录和可选集成的控制面。
消息、Codex 实体、工具参数和输出在客户端加密；Relay 只持久化不透明密文、版本、
序列号和路由元数据，不解密用户内容。

主要入口：

- `packages/happy-server/sources/main.ts`：常规 Fastify + Socket.IO 服务；
- `packages/happy-server/sources/standalone.ts`：PGlite 与本地文件存储模式；
- `packages/happy-server/sources/app/api`：HTTP、Socket.IO、认证和路由；
- `packages/happy-server/prisma`：Postgres 数据模型与迁移。

## 持久化与基础设施

| 能力 | 托管模式 | Standalone / Relay bundle |
| --- | --- | --- |
| 关系数据 | Postgres + Prisma | PGlite |
| 文件/头像 | S3 兼容对象存储；未配置时可用本地文件 | 本地持久目录 |
| 跨副本 Socket.IO | 配置 `REDIS_URL` 时启用 Redis Streams adapter | 单副本，不要求 Redis |
| 指标 | 可选 Prometheus 端点 | 按配置启用 |

Redis 不是服务启动前置条件。它只在多副本实时通知和 RPC 路由需要跨进程传播时启用；
没有 Redis 时，数据库同步与单进程 Socket.IO 仍可工作。

## HTTP 与同步面

`/v1`、`/v2` 保留账户、设备、会话目录、共享更新、资产、KV 和兼容基础设施。
可写 Codex 会话必须明确携带 `flavor=codex` 和 `codexSyncVersion=4`；空、未知或旧
provider 元数据不被当作 Codex。

Codex 的规范同步面是：

- `GET /v4/capabilities`；
- `POST /v4/sessions/:sessionId/mutations`；
- `GET /v4/sessions/:sessionId/changes?after_seq=N`；
- `GET /v4/sessions/:sessionId/snapshot`。

mutation 先持久化再 ACK；发送 ACK、接收 cursor 和 snapshot watermark 相互独立。
每个 session 的 `syncV4Seq` 提供顺序，mutation ID 提供幂等性。journal 保留恢复窗口；
过期 cursor 返回 snapshot-required，而不是猜测客户端状态。

## Sync v4 数据流

1. CLI 将 Codex thread、runtime、turn、item、part、request、command 和 relation 映射为独立实体。
2. CLI 在本地 journal 持久化 mutation 后，按 FIFO 上传密文。
3. Server 分配顺序并返回 ACK，不推进任何客户端的读取 cursor。
4. Socket.IO 只发送 `{ type: "sync-v4-invalidate", sessionId, highWatermark }`
   唤醒提示。
5. App/CLI 轮询 changes；缺口、缓存损坏或 HTTP 410 通过 snapshot 重建。
6. 客户端完成处理后才持久化自己的 cursor。

因此 Socket.IO 丢包、重复或断线不会决定数据正确性。共享 v3 update/RPC 基础设施仍被
保留组件使用，但不得为 Codex 新增规范状态。

## 实时与 RPC

`/v1/updates` 提供 user、session 和 machine 三种连接 scope。v1/v2 更新可通过
`update`/`ephemeral` 事件传播；点对点控制使用 `rpc-register`、`rpc-call` 和
`rpc-request`。配置 Redis 时房间与 RPC 注册可跨副本传播。详细兼容面见
[Realtime Sync and RPC](realtime-sync-and-rpc.md)。

## 会话生命周期

执行完成只来自 provider 权威生命周期或重建后的 snapshot。断开连接、RPC timeout、
interrupt ACK 和经过一段时间都不能把 turn 标记为完成。child Codex thread 映射为隔离、
只读的 side session；child 更新不能覆盖 parent runtime。

## 账户删除与对象访问

账户删除是不可撤回的两步操作：账户凭据先获取服务端生成、五分钟有效且单次消费的 challenge，
再提交与账户公钥匹配的 Ed25519 签名。确认操作在事务中消费 proof、标记账户删除进行中并创建
持久删除请求；普通 token、terminal token、Socket.IO 握手及后续入站事件和活动缓存都会重新检查
账户状态。确认同时通过 Redis adapter 断开所有副本的既有用户 scope 连接。逐事件检查发生在 handler
准入前，不等同于把账户状态原子加入每条业务写入。
确认后会拒绝新认证和新的 HTTP/Socket 读写准入。删除标记前已经进入普通处理器的数据库写入
可能先完成；最终删除事务会重新读取并清除这些主数据，不把连接断开误当成事务回滚。附件、头像和
presence 等会产生外部或长期状态的路径在最终写入处另有账户删除标记门槛。GitHub OAuth params 在
同一 Serializable 事务中取得账户写入准入、生成绑定 admission 的 state 并持久化 admission，只有事务
成功后才返回 state；callback 必须先原子 claim，claim 失败或重放不会交换 code、读取 profile 或上传
头像。删除器等待所有已 claim callback 通过 `completedAt` 明确结算；token POST 的传输或解析结果未知时
admission 不按 state TTL 自动释放。

App 在删除 proof 离开客户端前同步结束 token-bound outbound generation，停止全部 Sync 队列、Sync v4
client 与 git status sync，卸载 AppState/Web listener，并 reset user-scoped Socket；随后才持久化
revocation fence。每个账户 HTTP/backoff 物理请求和 Socket/RPC continuation 都携带初始化期 permit，
在加密、凭据读取或 ACK 等 `await` 后必须再次验证 generation，旧账户 continuation 不能借新登录的
token 或 Socket 外发。revocation 或未完成 bootstrap fence 存在、读取失败或竞争时，启动恢复与开发
E2E bootstrap 都 fail-closed，不会自动恢复旧凭据。另一设备已提交删除时，challenge 的 `409` 也必须
先完成同一本地撤销再报告 pending；proof 创建前的 `401/403` 不触发撤销。普通登出可在本地撤销后对
push token 发送一次 best-effort DELETE，但不得以旧凭据无限后台重试；账户删除不发送该请求。
Artifact REST/Socket create、update、delete 在账户写入事务中分配用户级 `updateSeq`；App 以删除
tombstone 阻止较旧 update 和延迟 fetch 复活对象，只有更大的 `new-artifact` 序号可以越过 tombstone。
每次真实 Artifact mutation 在同一事务递增 `Account.artifactRevision`；幂等重复 create 不递增、不发事件。
Artifact REST 列表使用账户绑定且签名的 opaque cursor 固定 `{ highWatermark, artifactRevision }`，按 id
分页读取 `updateSeq <= highWatermark` 的行。无关账户写入只推进全局 `Account.seq`，不会打断续页；
Artifact mutation 会使续页返回 409 并要求从首页重建。App 只有在取得全部页面后才提交快照：缺席项
会建立 tombstone、清除本地对象与解密 key，但 watermark 后到达的较新 lifecycle event 始终优先。

附件下载、Push dispatch 和 Socket RPC 在外部动作前取得账户行准入，等待或查找后还会重新核验；
删除标记后不再开始新的动作。删除标记前已经打开的响应流可完成，已经交给 Socket、Expo 或远端
provider 的请求只能尽力中止，不能与数据库事务原子撤回。

删除器先等待旧版直接 S3 上传能力的最长 15 分钟失效，并等待所有删除前获准的代理上传和头像写入
持久操作取得确认成功；操作记录对象 key 和完成时间，没有 TTL，失败或未知写入会让删除保持 pending。
随后才对当前 session 附件和 `public/users/<accountId>/` 执行唯一的最终对象 sweep，以 1000 条为上限
串行批删并复查所有 object version 和 delete marker。
S3 升级必须由部署者记录所有旧签发器已排空的时刻，最终 sweep 仅在该时刻至少过去 16 分钟后进行；
历史 orphan 附件由持久、全局限流的 GC 扫描，而不是由每个账户删除重试扫描整个 bucket。对象删除
失败会保留账户锁定和删除请求，随后重试。
最终事务先锁定已标记的 Account 行，再删除账户关联的会话、Sync v4 entities/mutations、设备、认证
请求、token、artifact、KV、语音、社交/Feed 引用、GitHub OAuth 记录及已结算 admission；不再被任何 Account 引用的
历史 GitHub 记录也会一并清理。对象访问始终经 Server：S3 bucket 必须保持私有，头像 `/files/*`
在流式读取前检查账户状态，附件 `PUT`/`GET` 需要会话授权。

应用无法控制托管备份和运维日志，也无法清除自托管部署者或第三方服务保留的副本；这些边界和
三天托管保留目标见 [隐私政策](../PRIVACY.md) 与当前
[账户删除归档计划](plans/archive/account-data-deletion-and-retention-contract.md)。

## 可选集成

- ElevenLabs 语音：`/v1/voice/conversations` 与 `/v1/voice/usage`；
- RevenueCat：订阅资格核验；
- GitHub：连接与 webhook；
- S3：文件对象存储；
- Prometheus：运维指标。

这些集成都不改变 Codex 消息的端到端加密边界。

## 部署与验证

开发、托管 Postgres 和 Debian 13 amd64 Relay bundle 的配置见
[部署文档](deployment.md)。可交付 Server/镜像只由
`.github/workflows/build-debian13-relay-release.yml` 构建；工作流验证 distroless、
非 root、只读根文件系统、迁移/重启、secret 权限、SBOM 和 Critical 漏洞门禁。
语音、GitHub OAuth/disconnect、Artifact、Push、Fastify 请求失败、受控调试、迁移与 retry 日志脱敏由
App/Server 的白名单 logger canary 和 hostile sentinel 测试验收；原始账户、会话、artifact、provider ID、
payload、token、data key、外部错误和堆栈不进入运维日志。部署 workflow 维持镜像与运行时安全验证，
详见[部署文档](deployment.md)。
