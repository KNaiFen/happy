# Happy Server standalone Docker 路径修复记录

## 状态

- 当前状态：已完成并归档。
- 完成说明：仓库根 `Dockerfile.server` 已修复为 Happy Server 的 PGlite 单容器入口；PR、
  merge SHA 的 main CI 以及 Relay `1.1.42` candidate/promotion 均已取得同源成功证据。
- 负责模块：`packages/happy-server` 与 Relay 部署维护者。
- 建立日期：2026-08-10。
- 完成日期：2026-08-11。
- 实现基线：`origin/main@e7060aaa37d9ddc30b80e31666a84f93f349a953`。
- 云端边界：任何新的 container 或可交付物验收都必须在 GitHub Actions 中运行，不在本机构建发行镜像。

## 修复前已确认事实

在本次实施前，`Dockerfile.server` 使用不存在的 `pnpm --filter happy-server`，而现行包名是
`happy-server-self-host`。它的 `CMD` 也启动标准 `start` entrypoint，该 entrypoint 默认使用 Postgres，而不是
PGlite standalone entrypoint。因此，当时 README 所声称的“单 container、不需 Postgres/Redis/S3”无法由该镜像实现。
受支持的发行路径是 Debian 13 amd64 Relay bundle。源码中的
`sources/standalone.ts` 仍可供开发/诊断使用，但它不是已验收的 root Docker 制品。

本次实施已将 root Dockerfile 改为正确 workspace 包、production standalone runtime 和既有
`migrate -> serve` entrypoint；PR 和 main 的真实镜像生命周期均已通过。Debian Relay
`1.1.42` 也已从相同 merge SHA 构建、验收并完成 promotion。

## 决策与实现

维护者于 2026-08-11 明确要求保留 root Docker 路径，并以 host root 启动的单容器
提供服务。host root 或 Docker daemon 控制者是受信任边界：其可读取挂载的 secret/volume、替换镜像
或以任意用户执行容器命令。容器内继续使用无特权 `65532:65532`，仅限制服务进程被攻陷后的容器内权限，
不因此放宽 root filesystem、capability 或 secret-file 约束。

实施采用以下契约：

1. `Dockerfile.server` 使用正确的 `happy-server-self-host` workspace 包、Bun 构建工具、
   已部署 production dependencies 和现有 standalone `migrate -> serve` entrypoint。
2. PGlite 与本地加密附件共同写入唯一 `/data` volume；默认端口为 `3005`，不要求
   Postgres、Redis 或 S3。
3. master secret 不写入镜像层、Docker Config 环境或日志，只从 `/run/secrets/happy_master_secret`
   读取；现有 entrypoint 会仅为服务 runtime 在进程内设置 `HANDY_MASTER_SECRET`。runtime 保持
   distroless、非 root、只读根文件系统、drop all capabilities 和受限 tmpfs。
4. Server CI 从 root Dockerfile 构建真实镜像，通过 host loopback 映射执行 health、migration、认证/会话、附件
   upload/download、重启持久性和运行时安全检查。镜像 build 在隔离 builder 内也覆盖 Server runtime build，
   因此不在 runner 上重复同一 build；本地只做脚本、分类器和文档源码验证。
5. `packages/happy-server` patch 升到 `1.1.42`。同 merge SHA 的 Debian Relay
   candidate/release 工作流已成功，root Docker CI 与既有 Relay 制品均有可复核证据。

## 完成证据

- 根 Dockerfile、单容器云端生命周期脚本、Server CI 接入、路径分类测试、README 与部署说明由
  [PR #48](https://github.com/KNaiFen/happy/pull/48) 提交。exact head
  `0f8c83a751c48e91a8aef5fc010f1d9b9fe9b410` 的
  [Documentation](https://github.com/KNaiFen/happy/actions/runs/31491682646)、
  [CLI Smoke](https://github.com/KNaiFen/happy/actions/runs/31491682680) 和
  [Monorepo CI](https://github.com/KNaiFen/happy/actions/runs/31491682853) 均成功；其中
  [Server standalone image job](https://github.com/KNaiFen/happy/actions/runs/31491682853/job/93779505968)
  用时 3 分 31 秒并完成真实容器生命周期。
- PR squash 合并为 `e7060aaa37d9ddc30b80e31666a84f93f349a953`。同 SHA 的
  [main Documentation](https://github.com/KNaiFen/happy/actions/runs/31493047036) 和
  [main Monorepo CI](https://github.com/KNaiFen/happy/actions/runs/31493047202) 均成功；
  [main Server job](https://github.com/KNaiFen/happy/actions/runs/31493047202/job/93784003731)
  用时 3 分 12 秒，
  [Required CI gate](https://github.com/KNaiFen/happy/actions/runs/31493047202/job/93787941879)
  也在同一 SHA 成功。
- [Relay release router](https://github.com/KNaiFen/happy/actions/runs/31494277699) 只选择
  `happy-server 1.1.42`，CLI、Android 与 happy-agent 发行均跳过。Relay 源码验证、离线 bundle
  构建、Critical 漏洞门禁、SBOM、最终安装器/迁移/重启验收和 promotion 全部成功。
- 不可变 candidate artifact
  [9102693188](https://github.com/KNaiFen/happy/actions/runs/31494277699/artifacts/9102693188)
  的 Actions ZIP digest 为
  `sha256:2c2a54acf62685a403d3a5fdcb8ef04087f57d426151e8f2f600354c6298feac`；promotion artifact
  [9102715177](https://github.com/KNaiFen/happy/actions/runs/31494277699/artifacts/9102715177)
  名为 `happy-relay-server-1.1.42-debian13-amd64`，Actions ZIP digest 为
  `sha256:2d5bfad222d11f5964a7174849608c847828c395d945b2b51df58867f0e1c98c`。
- 构建上下文排除所有 `.env` 文件；`.dockerignore`、workspace install 输入与 Dockerfile
  直接复制的 App sync schema 都会触发 Server/migration 验收。本地源码检查没有替代任何云端镜像验收。

## 验收标准

- `Dockerfile.server`、README 与部署文档对单容器、PGlite、port、数据卷、secret 和运行用户的说明一致。
- 云端从空 volume 启动镜像、经 host 映射端口通过真实 API 写入 PGlite 与附件，重启后仍可读取相同数据和正确的 host attachment URL。
- 镜像在不配置 Postgres、Redis 或 S3 时通过完整生命周期；服务进程为 `65532:65532`，root filesystem 只读，capabilities 全部移除，`no-new-privileges` 与受限 `/tmp` 生效。
- master secret 仅由 `root:65532 0440` 只读文件提供，不出现在镜像层、Docker Config 环境或日志中；现有 entrypoint 为服务进程在内存中传递所需值。
- PR/main、Relay `1.1.42` 工作流和制品都有精确 commit、run 与 artifact 证据；完成前不归档计划，不用本机镜像构建替代云端验收。

以上验收标准均已满足，本计划于 2026-08-11 归档。
