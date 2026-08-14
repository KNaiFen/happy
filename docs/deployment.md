# Happy Server 部署

> **当前文档（2026-08-11）：** root standalone Docker 与 Debian Relay 都使用
> PGlite 和本地持久存储；任何可交付镜像和 bundle 只由 GitHub Actions 构建。

## 运行模式

| 模式 | 数据库 | 文件存储 | Redis | 适用范围 |
| --- | --- | --- | --- | --- |
| 托管 Server | Postgres/Prisma | S3 兼容存储或本地目录 | 多副本时可选 | 云端/集群 |
| Standalone | PGlite | 本地持久目录 | 不需要 | 单机开发或嵌入 |
| Root standalone Docker | PGlite | `/data` Docker volume | 不需要 | 当前架构的单机单容器 |
| Debian 13 Relay bundle | PGlite/交付配置 | Docker volume | 不需要 | amd64 自托管 Relay |

常规入口是 `packages/happy-server/sources/main.ts`；standalone 入口是
`packages/happy-server/sources/standalone.ts`。

## 配置

所有模式都需要安全生成并持久保存的 master secret。源码模式使用
`HANDY_MASTER_SECRET`；受支持的容器路径从只读文件读取并只在进程内设置该值。
不要在升级时重建、输出或写入镜像配置。

托管 Postgres：

- `DATABASE_URL`：Prisma/Postgres 连接；
- `REDIS_URL`：可选；配置时启用跨副本 Socket.IO adapter；
- `S3_HOST`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`、`S3_PORT`、
  `S3_USE_SSL`：可选对象存储；bucket 必须保持私有，文件只经 Server 代理；
- 未配置 S3 时使用本地文件目录，该目录必须挂载持久卷。

通用配置：

- `PORT`：API 端口，默认 `3005`；
- `PUBLIC_URL`：客户端访问 Server 的公开基址；用于 Server 返回的文件路径，不是对象存储公开 URL；
- `METRICS_ENABLED` / `METRICS_PORT`：可选 Prometheus 指标；
- `GITHUB_*`：可选 GitHub 连接；
- `ELEVENLABS_API_KEY`：默认语音 agent；
- `REVENUECAT_API_KEY`：语音订阅资格；
- `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING`：只限受控开发环境。

目标安全边界要求生产日志不得记录 prompt、reasoning、tool 参数/输出、provider ID、
bearer token、加密 key 或签名材料。语音、GitHub OAuth/disconnect、Artifact、Push、Fastify 请求失败、
受控调试、迁移与 retry 路径都使用白名单日志：只允许固定事件名、枚举、状态类别、长度/计数、用量
区间和必要的 diagnostic hash；conversation token、context、原始账户/会话/artifact/provider 标识符、
请求 payload、data key 及原始 SDK/Error message 或 stack 一律不可进入运维日志。对应 canary 和 hostile
sentinel 覆盖成功与异常路径；语音实施记录见
[Voice 敏感日志收敛归档](plans/archive/voice-sensitive-logging-hardening-1.11.29-1.1.41.md)。

## 删除与保留边界

账户删除立即拒绝该 Happy 账户的新认证和新的读写准入，并可靠删除 Server 主数据和已配置对象存储中的账户对象；它没有导出、
撤回或恢复阶段。当前 Server 会将附件和 profile object 代理到自己，因而确认删除后不再为该账户
提供新的受控读取或写入能力。S3-compatible bucket 必须禁用匿名/public read 和 write；公开 bucket
或旧直连 URL 不受应用撤销控制，是部署配置错误。

所有启用 S3 的部署都必须以 ISO 8601 UTC 时间设置
`ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT`。从旧版直接 S3 上传协议升级时，只能在完成滚动
部署并确认所有旧 Pod 已停止签发 URL 后填入实际排空时间；全新、从未运行过旧签发器的 S3 部署可显式
使用 `1970-01-01T00:00:00Z` 作为该事实的配置声明。这是删除最终对象 sweep 的安全
栅栏：Server 将在该时间至少过去 16 分钟后才可报告 S3 账户删除完成；变量缺失、格式无效或落在
未来时，Server 拒绝启动新的账户删除，而不是猜测旧 capability 是否已失效。仅使用本地文件存储的
部署不需要该变量。

托管服务的备份和运维日志保留目标为最长三天，但备份调度、日志汇聚和实际删除证据位于本仓库外。
Server 会删除已配置主 bucket 中的所有对象版本和 delete marker；自托管部署者仍必须自行配置并验证
Postgres/PGlite backup、S3 replica/lifecycle/Object Lock、Redis、Docker/host 日志和外部 provider 的
保留策略。代码不会替部署者删除这些基础设施副本；Object Lock 或权限拒绝会让账户删除保持 pending。

数据库删除无法撤回已经发送到外部系统的数据：删除前已准入的附件响应流可能完成，已交给 Socket、
Expo 或远端 RPC provider 的动作只能尽力中止。删除标记会阻止新的准入，但不构成这些第三方已送达
副本的删除证明。

## Kubernetes 与容器

`packages/happy-server/deploy/handy.yaml` 和 `deploy/base`/`deploy/overlays` 是托管部署示例。
`handy.yaml` 自带单副本 Redis StatefulSet；部署者可以用外部 Redis 替换它。本地 overlay 另提供
Postgres、MinIO、Prometheus 和 Grafana 示例，并把 `PUBLIC_URL` 固定为配套
`kubectl port-forward svc/handy-server 3005:3000` 的 `http://localhost:3005`。
如果客户端通过 NodePort、局域网地址或其他入口访问，部署者必须把该值改为同一个客户端可达基址；
空值不能替代这项配置，因为请求之外产生的 profile 更新无法推导请求 Host。

`Dockerfile.server` 是受支持的 standalone 单容器源码构建入口。它使用 PGlite、
本地附件目录、`/data` 持久卷和 port `3005`，不需要 Postgres、Redis 或 S3。
host 可由 root 执行 Docker，但 host root/Docker daemon 是受信任边界，可读取挂载数据或替换
容器；镜像内服务以 `65532:65532` 运行只限制服务进程被攻陷后的容器内权限。部署时必须保持
root filesystem 只读、drop all capabilities、启用 `no-new-privileges`、为 `/tmp`
提供受限 tmpfs，并从 `/run/secrets/happy_master_secret` 挂载 `root:65532 0440`
的 secret 文件。完整命令见 [Happy Server README](../packages/happy-server/README.md#standalone-docker-image-single-container)。

默认命令只绑定 `127.0.0.1:3005`。原生 App 或 CLI 需要可信局域网访问时，必须显式同时
修改 published address 与 `PUBLIC_URL`，并用主机防火墙限制来源；普通 HTTP 仅适用于该
可信网络 opt-in，Web 客户端仍只允许 HTTPS 或 localhost。

Monorepo CI 必须从根 Dockerfile 构建真实镜像，并验证 migration、health、真实附件
上传/下载、容器重启后的 PGlite 与附件持久性，以及上述运行时安全约束。该源码构建
入口不是 registry 发布物，也不替代下面的 Debian 离线 bundle。

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
secret ownership、SBOM 与 Critical vulnerability gate。语音日志脱敏由 App/Server
源码 canary 和 monorepo CI 验收；Relay workflow 不单独复跑该测试。成功前不得把产物称为已发布。

## 升级

升级现有 Relay 时保留 `.env`、`secrets/master-secret` 和数据 volume，不清库、不重建
secret。升级后验证 health、设备/会话目录、Sync v4 mutation/change/snapshot、重启恢复、
容器安全约束和物理 CLI/App 生命周期。

Relay `1.1.40` 的现场升级已完成；历史证据见
[Debian Relay 现场升级归档](plans/archive/debian13-amd64-relay-bundle-1.1.40-field-upgrade.md)。
