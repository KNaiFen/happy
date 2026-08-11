# Happy Server standalone Docker 路径修复计划

## 状态

- 当前状态：进行中（维护者已决定保留并修复为单容器；等待 PR/main 云端镜像验收与归档）。
- 负责模块：`packages/happy-server` 与 Relay 部署维护者。
- 建立日期：2026-08-10。
- 云端边界：任何新的 container 或可交付物验收都必须在 GitHub Actions 中运行，不在本机构建发行镜像。

## 修复前已确认事实

在本次实施前，`Dockerfile.server` 使用不存在的 `pnpm --filter happy-server`，而现行包名是
`happy-server-self-host`。它的 `CMD` 也启动标准 `start` entrypoint，该 entrypoint 默认使用 Postgres，而不是
PGlite standalone entrypoint。因此，当时 README 所声称的“单 container、不需 Postgres/Redis/S3”无法由该镜像实现。
受支持的发行路径是 Debian 13 amd64 Relay bundle。源码中的
`sources/standalone.ts` 仍可供开发/诊断使用，但它不是已验收的 root Docker 制品。

本次实施已将 root Dockerfile 改为正确 workspace 包、production standalone runtime 和既有
`migrate -> serve` entrypoint；该结论仍等待本次 PR head 的真实镜像生命周期 CI 复核，不能提前当作已发布制品。

## 决策与下一步

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
5. `packages/happy-server` patch 升到 `1.1.42`。PR/main CI 成功后等待同 merge SHA 的
   Debian Relay candidate/release 工作流，记录 root Docker CI 与现有 Relay 制品证据后归档本计划。

## 当前证据与剩余工作

- 根 Dockerfile、单容器云端生命周期脚本、Server CI 接入、路径分类测试、README 与部署说明已进入本次实施分支。构建上下文会排除所有 `.env` 文件；`.dockerignore`、workspace install 输入与 Dockerfile 直接复制的 App sync schema 都会触发 Server/migration 验收。
- 本地源码检查不得替代镜像验收；当前尚无本次变更的 PR head、main merge SHA、root Docker lifecycle job 或 Relay `1.1.42` workflow 证据。
- 下一步是完成本地源码验证，提交并创建 PR；PR exact-head CI 通过后合并，再等待 main CI 与 Relay workflow，最后补充精确 run/artifact 链接并归档。

## 验收标准

- `Dockerfile.server`、README 与部署文档对单容器、PGlite、port、数据卷、secret 和运行用户的说明一致。
- 云端从空 volume 启动镜像、经 host 映射端口通过真实 API 写入 PGlite 与附件，重启后仍可读取相同数据和正确的 host attachment URL。
- 镜像在不配置 Postgres、Redis 或 S3 时通过完整生命周期；服务进程为 `65532:65532`，root filesystem 只读，capabilities 全部移除，`no-new-privileges` 与受限 `/tmp` 生效。
- master secret 仅由 `root:65532 0440` 只读文件提供，不出现在镜像层、Docker Config 环境或日志中；现有 entrypoint 为服务进程在内存中传递所需值。
- PR/main、Relay `1.1.42` 工作流和制品都有精确 commit、run 与 artifact 证据；完成前不归档计划，不用本机镜像构建替代云端验收。
