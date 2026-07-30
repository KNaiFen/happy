# Debian 13 amd64 Happy Relay 1.1.24 发布计划

## 状态

- 当前状态：修复 1.1.23 发布门禁，等待重新发布
- 目标版本：Server `1.1.24`
- 本地实现归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.23-local.md`
- 1.1.23 云端门禁归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.23-ci.md`
- 旧版本归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.15-1.1.22.md`

本文件只保留尚未完成的发行和升级事项。

## 待完成

- [ ] main release 构建 `linux/amd64` Debian 13 distroless relay image。
- [ ] Trivy Critical gate、SBOM、SHA-256、路径/链接和 relay-only 内容检查通过。
- [ ] 最终 tarball lifecycle 完成真实认证、非空 Machine/Session、重启持久性和
      v4 toggle 验证。
- [ ] 下载并校验 relay `1.1.24` tarball 与 `.sha256`。
- [ ] 在服务器原目录升级，保留：
      `.env`、`secrets/master-secret`、`happy-relay_happy-data` 和 v4 选择。
- [ ] 升级后验证 `/health`、`/v1/machines`、`/v1/sessions`、容器安全约束和日志。
- [ ] 物理设备验收完成后把发行记录归档。

## 不变契约

- 镜像只包含 relay，不包含 Web App。
- 宿主以 root 管理；容器保持 `65532:65532` 非 root。
- 默认绑定 `127.0.0.1:3005`；HTTP 只用于显式可信网络。
- 不清库、不删 volume、不重建 master secret。
- 只读根文件系统、drop all capabilities、`no-new-privileges`、`/tmp` tmpfs。

## 变更记录

- 2026-07-30：本地 `1.1.23` 修复归档；活动文件缩减为云端发行和原卷升级清单。
- 2026-07-30：分支 CI 全绿并同步 main；1.1.23 release 因 ShellCheck
  SC2016 误判停止且未产生制品，归档该阶段并推进 1.1.24。
