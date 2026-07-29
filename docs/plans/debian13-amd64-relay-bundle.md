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
4. `HANDY_MASTER_SECRET` 由以 root 运行的安装脚本首次生成到本地 secret 文件，
   权限固定为 `root:65532 0440`，并由 `0700` 的 root-owned 父目录保护。Compose
   以 file secret 只读挂载，容器内固定 GID `65532` 可读；不得写入容器环境、
   镜像、`.env`、日志或 Artifact 元数据。安装和管理命令明确要求宿主 root，
   但服务容器始终保持 UID/GID `65532` 非 root。root 脚本在修改所有权或启动
   Compose 前必须拒绝符号链接、非预期文件类型和多重硬链接，避免跟随或修改被
   替换的 secret 路径。
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
10. 首次发行 `1.1.15` 被 ShellCheck 门禁阻断；`1.1.16` 缺少 App 跨包契约
    schema；`1.1.17` 被 runtime Critical CVE 门禁阻断。修复版本目标为 Server
    `1.1.22`。CLI `1.4.5`、App `1.11.11`、Wire `0.1.3` 不因纯 Server 打包
    变化推进版本。
11. runtime 使用官方 `gcr.io/distroless/nodejs24-debian13:nonroot` amd64 镜像。
    入口、健康检查和生命周期断言使用 Node，不携带 shell、npm、Perl、curl、
    ffmpeg 或其他运行时包管理工具；builder 仍可使用完整工具链。
12. Trivy 继续扫描 `os,library`、阻断全部 Critical 且保持
    `ignore-unfixed: false`。不得通过忽略 Debian 无修复 CVE 完成发行；镜像必须
    从运行时文件系统中移除不需要且触发漏洞的组件。

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
- 直接导入构建后的 `dist/standalone.mjs`，确认 distroless 入口依赖的
  `runMigrations` 与 `serve` 导出没有被 bundler 丢弃。
- 在 `pnpm deploy --prod --legacy` 产生的最终生产依赖树中再次使用 Node 24 导入
  `dist/standalone.mjs`；只在 workspace 根依赖上导入不足以证明镜像中的
  ESM/CommonJS 互操作正确。
- 使用 ShellCheck、Compose config 和包结构检查验证安装/管理脚本。
- 在镜像构建前用合成的九文件 tarball 回归验包器：脚本中的说明性占位符字面量
  不得误报，唯一模板输出 `env.example` 中的未解析占位符必须阻断。

### 镜像门禁

- 使用 Buildx 构建并加载单平台 `linux/amd64` 镜像。
- 断言 OCI architecture 为 `amd64`，容器内 Debian `VERSION_ID=13`，运行
  UID 为 distroless nonroot 的 `65532`，并确认不存在 `webapp/index.html`、
  shell、npm、Perl、APT。
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
- 检查宿主 secret 为 `root:65532 0440`，容器内挂载保持相同所有权和模式，并确认
  `HANDY_MASTER_SECRET` 与 Compose secret 来源变量都不在容器配置环境中。
- 用隔离目录模拟 `secrets/`、`secrets/master-secret` 符号链接和多重硬链接，确认
  root 安装器在执行 `chown`、加载镜像或启动 Compose 前拒绝它们，且链接目标不
  被修改。

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
- 2026-07-29：失败镜像日志显示未使用的 `ffmpeg` 依赖树安装耗时约 98 秒；仓库
  检索确认 Server 不调用它。`1.1.17` 同步移除 `ffmpeg`，缩小镜像、攻击面和
  Trivy 扫描面，只保留 `ca-certificates` 与 `curl`。
- 2026-07-29：分支 CI run `30445575275` 全绿，真实 Codex turn 持续
  `10m57s`。main 发行 run `30446371278` 的镜像构建和 relay-only 身份检查通过，
  随后 Trivy 阻断 5 个 Critical：Node runtime 自带 npm 的 `tar 7.5.15` 有
  `7.5.19` 修复，Debian slim 的 `perl-base` 有 4 个当前无修复项，其中一个仅
  影响 32 位。`1.1.17` 不得复用；`1.1.18` 改用官方 Node 24 Debian 13
  distroless nonroot runtime，彻底移除 npm、Perl、shell 和多余 OS 工具，同时
  保持 Critical 门禁不放宽。
- 2026-07-29：`1.1.18` 分支 CI run `30448712684` 与 main CI run
  `30449521598` 全绿；发行 run `30449522912` 的 distroless 镜像构建、身份检查、
  严格 Critical Trivy 和 SBOM 均通过，但最终验包器递归扫描到 `install.sh` 中
  用于再次处理已版本化 `env.example` 的字面量 `__VERSION__`，产生确定性误报。
  `1.1.18` 不得复用；`1.1.19` 删除安装阶段的多余二次模板化，并把占位符检查
  限定到唯一模板输入 `env.example`，不再扫描脚本、SBOM 或压缩镜像二进制。
- 2026-07-29：`1.1.19` 分支 CI run `30450943994` 与 main CI run
  `30451805026` 全绿；发行 run `30451805083` 通过镜像、身份、严格 Trivy、SBOM、
  合成验包回归和最终 tarball 校验，但真实安装时 distroless UID `65532` 无法读取
  宿主 `0600` file-backed Compose secret，服务按预期拒绝启动。Docker 官方文档
  明确 file 来源底层使用 bind mount 且静默忽略 `uid/gid/mode`，仅 environment
  来源支持所有权映射。`1.1.19` 不得复用；`1.1.20` 保留宿主文件 `0600`，通过
  管理脚本短暂提供 environment-backed secret，并断言两个 secret 变量都不进入
  容器配置环境。
- 2026-07-29：`1.1.20` 分支 CI run `30453889993` 全绿；main CI run
  `30454868475` 首次因两个 CLI 测试在 runner 高负载下超过 5 秒失败，本地对应
  文件 `20/20` 通过，GitHub 原生失败 job 重跑 attempt 2 全绿。发行 run
  `30454865700` 再次通过所有镜像与 tarball 门禁，但 Compose 在只读服务上拒绝
  environment-backed secret，明确报错仅 file 来源受支持。`1.1.20` 不得复用；
  用户确认宿主以 root 运行后，`1.1.21` 恢复 file secret，由 root 安装器把唯一
  secret 文件设为 `root:65532 0440`。这保留只读根文件系统、非 root 服务和
  宿主 `0700` 父目录保护，不引入环境泄漏或第二份持久 secret。最终安全审查同时
  要求安装器和管理脚本拒绝 secret 目录、文件符号链接和多重硬链接，生命周期
  测试覆盖 root 路径替换场景。
- 2026-07-29：`1.1.21` 分支 CI run `30457361452` 与 main CI run `30458364083`
  全绿，真实 Codex turn 分别持续 `10m56s` 和 `11m5s`。发行 run `30458364326`
  通过源码/runtime 校验、镜像身份、严格 Critical Trivy、SBOM、最终 tarball 和
  root 安装器的链接防护、secret 生成及 Compose 创建，但生产容器启动时失败：
  standalone ESM 从部署后的 CommonJS `@prisma/client` 读取具名导出
  `RelationshipStatus`，Node 24 拒绝加载。`1.1.21` 不得复用；`1.1.22` 必须修复
  最终 production dependency tree 的 Prisma ESM/CJS 互操作，并把该树上的真实
  Node import 前移为镜像构建门禁，避免再次等待 120 秒健康超时才发现入口错误。
