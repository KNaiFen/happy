# Happy Server 部署

> **当前文档（2026-08-05）：** Redis 与 S3 都是可选能力；Debian Relay 的可交付镜像
> 和 bundle 只由 GitHub Actions 构建。

## 运行模式

| 模式 | 数据库 | 文件存储 | Redis | 适用范围 |
| --- | --- | --- | --- | --- |
| 托管 Server | Postgres/Prisma | S3 兼容存储或本地目录 | 多副本时可选 | 云端/集群 |
| Standalone | PGlite | 本地持久目录 | 不需要 | 单机开发或嵌入 |
| Debian 13 Relay bundle | PGlite/交付配置 | Docker volume | 不需要 | amd64 自托管 Relay |

常规入口是 `packages/happy-server/sources/main.ts`；standalone 入口是
`packages/happy-server/sources/standalone.ts`。

## 配置

所有模式都需要安全生成并持久保存的 `HANDY_MASTER_SECRET`。不要在升级时重建或输出它。

托管 Postgres：

- `DATABASE_URL`：Prisma/Postgres 连接；
- `REDIS_URL`：可选；配置时启用跨副本 Socket.IO adapter；
- `S3_HOST`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`、
  `S3_PUBLIC_URL`、`S3_PORT`、`S3_USE_SSL`：可选对象存储；
- 未配置 S3 时使用本地文件目录，该目录必须挂载持久卷。

通用配置：

- `PORT`：API 端口，默认 `3005`；
- `METRICS_ENABLED` / `METRICS_PORT`：可选 Prometheus 指标；
- `GITHUB_*`：可选 GitHub 连接；
- `ELEVENLABS_API_KEY`：默认语音 agent；
- `REVENUECAT_API_KEY`：语音订阅资格；
- `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING`：只限受控开发环境。

目标安全边界要求生产日志不得记录 prompt、reasoning、tool 参数/输出、provider ID、
bearer token、加密 key 或签名材料。语音链路尚有已核验的 user/conversation ID 与
context/token 调试日志缺口，见
[Voice 敏感日志收敛计划](plans/voice-sensitive-logging-hardening.md)。

## Kubernetes 与容器

`packages/happy-server/deploy/handy.yaml` 和 `deploy/base`/`deploy/overlays` 是托管部署示例。
本仓库没有 `happy-redis.yaml`；Redis 若需要由部署环境单独提供。本地 overlay 提供
Postgres、MinIO、Prometheus 和 Grafana 示例。

`Dockerfile.server` 是通用 Server 镜像入口。不要把它与 Debian Relay 交付混淆。

## Debian 13 amd64 Relay

交付定义位于 `packages/happy-server/deploy/debian13-amd64`，工作流为
`.github/workflows/build-debian13-relay-release.yml`。

固定契约：

- 镜像只包含 Relay，不包含 Web App；
- host 安装与 `relayctl.sh` 以 root 运行，容器保持 `65532:65532`；
- root filesystem 只读，drop all capabilities，`no-new-privileges`，只给 `/tmp` tmpfs；
- master secret 以窄范围 file secret 挂载；
- 默认绑定 `127.0.0.1:3005`；HTTP 仅允许显式可信网络；
- bundle 包含镜像、compose、安装/控制脚本、SBOM、manifest 和 SHA-256。

云端工作流验证镜像身份、amd64、distroless runtime、部署依赖、迁移、重启持久性、
secret ownership、SBOM 与 Critical vulnerability gate。它尚未验收语音 payload 日志脱敏；
该项以活动整改计划为准。成功前不得把产物称为已发布。

## 升级

升级现有 Relay 时保留 `.env`、`secrets/master-secret` 和数据 volume，不清库、不重建
secret。升级后验证 health、设备/会话目录、Sync v4 mutation/change/snapshot、重启恢复、
容器安全约束和物理 CLI/App 生命周期。

当前现场事项见 [Debian Relay 活动计划](plans/debian13-amd64-relay-bundle.md)。
