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
语音 payload 日志脱敏由 App/Server 的白名单 logger canary 和 monorepo CI 验收；部署
workflow 维持镜像与运行时安全验证，详见[部署文档](deployment.md)。
