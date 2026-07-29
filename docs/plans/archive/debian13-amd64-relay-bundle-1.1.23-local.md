# Debian 13 amd64 Happy Relay 1.1.23 本地修复归档

## 状态

- 实施日期：2026-07-30
- 本地状态：完成
- 版本：Server `1.1.23`
- 后续入口：`docs/plans/debian13-amd64-relay-bundle.md`

## 完成内容

- 修复 relay `1.1.22` 最终镜像中 PGlite / Prisma adapter 的不兼容组合。
- 精确固定 PGlite `0.3.15`、adapter `0.6.1` 和 Prisma `6.19.2`。
- production tree verifier 校验声明版本、实际安装版本、peer range、driver utils
  major，并拒绝测试兼容 alias 进入 production。
- `/health` 增加真实 Prisma `BYTEA` 形状检查。
- 5xx 日志和响应不再泄漏 Prisma message、stack、密钥字节或请求 metadata。
- 最终 bundle 生命周期新增真实认证、Machine/Session 非空密钥创建、列表读取、
  容器重启和再次读取。
- 精确模拟 `1.1.22` runtime 写入目录，新 runtime 原地读取完全相同的账户、
  Machine、Session、ID 和密钥。

## 保持的发行契约

- 纯 relay，不包含 Web App、Redis、外部 PostgreSQL 或 S3。
- OCI `linux/amd64`，Debian 13 distroless Node 24。
- 宿主管理由 root 执行，容器保持 UID/GID `65532`。
- named volume `happy-relay_happy-data`、master secret、`.env` 和 v4 选择原地保留。
- secret 为 `root:65532 0440`，父目录 `0700`。
- 只读根文件系统、drop all capabilities、`no-new-privileges`、`/tmp` tmpfs。
- 默认 `127.0.0.1:3005`；HTTP 只用于显式可信网络。
- tarball 离线安装，严格 SHA-256、SBOM、路径和链接检查。
- Trivy 对 fixed/unfixed Critical 均阻断。

## 本地证据

- Server typecheck 和 `116/116` unit tests 通过。
- 100,000 mutation chaos 通过。
- 38 个 migration 和 Prisma Bytes round-trip 通过。
- 精确旧 runtime 卷兼容测试通过。
- 冻结 lockfile 安装通过。
- production audit 为 `0 critical`。
- lifecycle Shell 语法通过。
- production deploy tree 版本和测试 alias 隔离已核对。

Docker image build、Trivy、distroless 内容、最终 tarball lifecycle 和 artifact
校验转交 GitHub Actions。
