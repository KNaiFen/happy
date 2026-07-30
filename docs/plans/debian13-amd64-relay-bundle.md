# Debian 13 amd64 Happy Relay 1.1.24 现场升级计划

## 状态

- 当前状态：云端 bundle 已发布并独立校验，等待原目录升级
- 版本：Server `1.1.24`
- 发布归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.24-release.md`
- 1.1.23 修复与门禁归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.23-local.md`
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.23-ci.md`
- 旧版本归档：
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.15-1.1.22.md`

本文件只保留服务器现场未完成事项。

## 待完成

- [ ] 在现有服务器原目录升级，保留：
      `.env`、`secrets/master-secret`、`happy-relay_happy-data` 和 v4 选择。
- [ ] 升级后验证 `/health`、`/v1/machines`、`/v1/sessions`、重启持久性、
      容器安全约束和脱敏日志。
- [ ] CLI/App 物理设备验收完成后归档本文件。

## 不变契约

- 镜像只包含 relay，不包含 Web App。
- 宿主以 root 管理；容器保持 `65532:65532` 非 root。
- 默认绑定 `127.0.0.1:3005`；HTTP 只用于显式可信网络。
- 不清库、不删 volume、不重建 master secret。
- 只读根文件系统、drop all capabilities、`no-new-privileges`、`/tmp` tmpfs。

## 变更记录

- 2026-07-30：1.1.24 云端构建、Trivy、生命周期和本地制品校验完成并归档；
  活动文件缩减为原目录升级与现场验收。
