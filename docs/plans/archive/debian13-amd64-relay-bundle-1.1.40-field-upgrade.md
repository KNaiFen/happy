# Debian 13 amd64 Happy Relay 现场升级计划

> **历史归档（2026-08-06）：** Relay `1.1.40` 已在现有服务器原目录完成升级，
> 服务与其他会话正常。现场验收发现的首页旧会话恢复及状态展示问题属于 App/CLI
> 缺陷，已转入 [旧会话恢复计划](../codex-home-old-session-resume-state-regression.md)。

## 状态

- 当前状态：已完成并归档；Relay `1.1.40` 云端制品和原目录现场升级均已交付。
- 验收结论：服务器并未离线；首页旧会话的恢复失败和局部 Gateway 假状态已单独立项。
- 历史构建与修复记录：见 [计划归档](README.md)。

## 待完成

- [x] 在现有服务器原目录执行升级，保留 `.env`、`secrets/master-secret`、
      `happy-relay_happy-data` 和当前 Sync v4 数据。
- [x] 升级后验证 `/health`、`/v1/machines`、`/v1/sessions`、Sync v4
      mutation/change/snapshot、重启持久性和日志脱敏。
- [x] 验证容器仍为非 root、只读根文件系统、drop all capabilities、
      `no-new-privileges` 和仅 `/tmp` tmpfs。
- [x] 使用 CLI `1.4.42` 与 App `1.11.28` 完成现场升级验收；旧会话恢复异常已转入独立缺陷计划。
- [x] 将现场结论写入执行记录并归档本计划。

## 不变契约

- Bundle 与运行镜像只包含 Relay，不包含 Happy Web App。
- 宿主安装和 `relayctl.sh` 以 root 运行；容器保持 `65532:65532` 非 root。
- 默认绑定 `127.0.0.1:3005`；HTTP 仅允许显式可信网络。
- 不清库、不删除 volume、不重新生成 master secret。
- 只交付 GitHub Actions 构建且通过校验的 Debian 13 amd64 离线 bundle。

## 当前版本

- Server：`1.1.40`
- 产物：`happy-relay-server-1.1.40-debian13-amd64.tar.gz`
- 工作流：`.github/workflows/build-debian13-relay-release.yml`
