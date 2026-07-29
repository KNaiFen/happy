# Debian 13 amd64 Happy Relay 一键包计划

## 目标

为 `origin/main` 提供独立的 GitHub Actions 发行工作流，按
`happy-server-self-host` patch 版本变更构建可在 Debian 13 x86_64 主机上
直接安装的纯中继服务器 Docker 包。

发行物只包含 Happy relay API、Socket.IO、PGlite、Prisma migrations 和
本地附件存储，不包含 Happy Web App、Redis、外部 PostgreSQL、S3 或客户端。

## 已锁定决策

1. 目标平台固定为 OCI `linux/amd64`，容器用户空间固定为 Debian 13
   (`trixie`)；云端必须同时验证镜像架构和 `/etc/os-release`。
2. 使用单容器 standalone Server。PGlite 数据库和附件位于 `/data`，通过
   Compose named volume 跨重启、升级和重新解压安装包保留。
3. 镜像使用非 root 用户运行，Compose 启用 `no-new-privileges`、删除全部
   Linux capabilities、使用只读根文件系统并为 `/tmp` 提供 tmpfs。
4. `HANDY_MASTER_SECRET` 由安装脚本首次生成到本地 secret 文件，通过
   Compose secret 只读挂载；不得写入镜像、`.env`、日志或 Artifact 元数据。
5. 新安装默认只绑定 `127.0.0.1:3005`。暴露到局域网必须显式修改 bind 和
   `PUBLIC_URL`；HTTP 仍只适用于可信网络，主动 MITM 下不承诺 token、ACK、
   server identity、metadata 或零丢失。
6. `HAPPY_CODEX_SYNC_V4_ENABLED` 新安装默认 `false`。只有匹配 CLI/App 已
   安装且没有旧版 Codex turn 时，才通过管理脚本显式开启。
7. 安装脚本必须幂等：重复运行会加载新镜像并更新 image tag，但保留 secret、
   v4 选择和 named volume；不得提供隐式 reset、`--remove-orphans` 或删除数据
   路径。若已有 named volume 但安装目录缺少 secret，必须拒绝生成新身份。
8. 发布包是离线可安装 tarball，内含 Docker image tar、Compose、安装脚本、
   管理脚本、配置示例、说明、SBOM 和 SHA-256 清单。运行时不要求访问 GHCR。
9. 发行工作流只由 `packages/happy-server/package.json` 的稳定版本递增触发；
   修复失败发行必须再次推进 Server patch，不复用已运行版本。
10. 首次发行 `1.1.15` 被 ShellCheck 门禁阻断；`1.1.16` 在 Docker builder
    类型检查时发现缺少 App 跨包契约 schema。修复版本目标为 Server `1.1.17`。
    CLI `1.4.5`、App `1.11.11`、Wire `0.1.3` 不因纯 Server 打包变化推进版本。

## 发行包契约

外层文件名：

```text
happy-relay-server-<version>-debian13-amd64.tar.gz
happy-relay-server-<version>-debian13-amd64.tar.gz.sha256
```

tarball 固定解压为 `happy-relay/`：

```text
happy-relay/
├── VERSION
├── README.md
├── compose.yaml
├── env.example
├── install.sh
├── relayctl.sh
├── SHA256SUMS
├── sbom.cdx.json
└── image/
    └── happy-relay-server-<version>-debian13-amd64.image.tar.gz
```

运行时生成但不进入发行包：

```text
happy-relay/
├── .env
└── secrets/
    └── master-secret
```

Compose project name 固定为 `happy-relay`，确保从新版本目录运行时仍复用
`happy-relay_happy-data` named volume。

## 云端工作流

### 版本与代码门禁

- 读取前一提交与当前 `packages/happy-server/package.json`；只接受递增的稳定
  `X.Y.Z`。
- 使用仓库固定 pnpm `10.11.0` 安装 frozen lockfile。
- 运行 Wire build、Server typecheck、Server unit tests 和 Server runtime build。
- 使用 ShellCheck、Compose config 和包结构检查验证安装/管理脚本。

### 镜像门禁

- 使用 Buildx 构建并加载单平台 `linux/amd64` 镜像。
- 断言 OCI architecture 为 `amd64`，容器内 Debian `VERSION_ID=13`，运行
  UID 非 0，并确认不存在 `webapp/index.html`。
- Trivy 对可修复和不可修复的 Critical 漏洞均阻断发布，并生成 CycloneDX
  SBOM。
- 镜像 OCI labels 必须包含 Server 版本、源提交和仓库 URL。

### 真实业务门禁

- 从最终 tarball 解压后运行同一个 `install.sh`，不得绕过交付脚本直接启动。
- 验证默认端口只绑定 loopback、`/health` 实际查询 PGlite 后返回 200、
  `/v4/capabilities` 初始报告 `enabled=false`。
- 重复运行安装脚本，确认 master secret 不变且服务仍健康。
- 重启容器并确认 `/data/pglite` 存在、迁移不重复失败、named volume 未变化。
- 使用 `relayctl.sh enable-v4` 切换后确认 capability 为 `enabled=true`，再切回
  `false`，证明开关可逆且不会删除数据库。
- 检查容器实际 security options、只读根文件系统和 dropped capabilities。

### Artifact 门禁

- 校验 tar 路径没有绝对路径或 `..`，脚本 executable bit 正确，secret 和
  `.env` 不在包内；拒绝 symlink、hardlink、特殊文件及重复成员名。
- 校验 image archive、SBOM 和固定文件的 SHA-256。
- 上传单一 versioned Artifact，保留 30 天；成功后下载到本地
  `dist/release-artifacts/` 并再次验包。

## 安装与升级语义

Debian 13 amd64 主机只需 Docker Engine、Docker Compose v2 和当前用户对
Docker daemon 的访问权限：

```bash
tar -xzf happy-relay-server-<version>-debian13-amd64.tar.gz
cd happy-relay
./install.sh
```

升级时将新 tarball 解压到原 `happy-relay/` 目录或让新目录复用同一 Compose
project；`install.sh` 更新镜像 tag 后执行 `docker compose up -d`。`.env`、
secret 和 named volume 必须保持原值。

停止服务使用 `./relayctl.sh stop`，不会删除 named volume。任何删除 volume、
重新生成 master secret 或 `docker compose down -v` 的操作都不进入一键脚本。

## 完成定义

- 分支全面 CI 全绿。
- main 全面 CI 与 Debian 13 relay release workflow 全绿。
- 发行物可在云端从空环境安装、重复安装、重启和切换 v4，数据库始终健康。
- Artifact 名称、Server 版本、镜像 label、Debian 版本和 amd64 架构一致。
- 本地下载后的 tarball 和内部文件 SHA-256 全部通过。
- 最终交付 Artifact URL、本地绝对路径、SHA-256 和五行以内的安装命令。

## 状态

- 2026-07-29：计划建立；范围按用户确认收窄为纯 relay，不包含 Web App。
- 2026-07-29：完成专用 Debian 13 amd64 非 root 镜像、PGlite named volume、
  Compose secret、loopback 默认绑定、幂等安装器、无数据删除的管理脚本、离线
  tarball 封装与严格验包器。
- 2026-07-29：完成版本触发的云端工作流；门禁覆盖 Server `110/110` 单元测试、
  ShellCheck、Compose config、amd64/Debian 13/无 Web App 身份、Critical Trivy、
  CycloneDX SBOM、实际安装/重复安装/重启/PGlite 持久化/v4 切换和容器加固。
- 2026-07-29：本地 Server typecheck 与 `110/110` 测试通过；本机没有 Docker、
  ShellCheck、actionlint 或 Bun，镜像/runtime build 和真实生命周期按约束留给
  GitHub Actions。待分支 CI、main CI、发行工作流及下载后复验完成后关闭计划。
- 2026-07-29：main 发行 run `30443462489` 在镜像构建前被 ShellCheck 阻断：
  两处 SC1007 和三处有意单引号 JavaScript 的 SC2016。修复使用明确的空
  `CDPATH` 与局部 SC2016 抑制；因 `1.1.15` 已运行发行 workflow，目标推进到
  `1.1.16`，不得复用失败版本。
- 2026-07-29：分支完整 CI run `30443860256` 全绿，真实 Codex turn 持续
  `11m11s` 后正常完成。main 发行 run `30444619009` 越过 ShellCheck 和 Server
  runtime 门禁，但 Docker builder 的 Server typecheck 因未复制 App 的 4 个纯
  Zod 跨包契约 schema 报 TS2307；这些文件只加入 builder，不进入最终 runtime。
  `1.1.16` 已运行发行 workflow，目标推进到 `1.1.17`，不得复用失败版本。
