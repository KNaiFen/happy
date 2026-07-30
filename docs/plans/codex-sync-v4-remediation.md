# Codex Sync v4 R8 现场升级与验收计划

## 状态

- 当前状态：代码、main CI 和云端制品完成，等待现场部署与物理设备验收
- 发布版本：CLI `1.4.6`、Server `1.1.24`
- 保持版本：App `1.11.11`、Wire `0.1.3`
- 云端发布归档：
  `docs/plans/archive/codex-sync-v4-remediation-r8-cloud-release.md`
- 本地实现归档：
  `docs/plans/archive/codex-sync-v4-remediation-r8-local.md`
- R1-R7 归档：
  `docs/plans/archive/codex-sync-v4-remediation-r1-r7.md`

本文件只保留现场未完成事项；实现、CI 和制品证据不再重复展开。

## 待完成

- [ ] 保留原 `.env`、master secret、named volume 和 v4 选择，原地升级 relay。
- [ ] 安装 CLI `1.4.6`，停止旧 daemon，并针对新 relay 重新启动和配对。
- [ ] 确认没有旧版正在运行的 Codex turn，再启用
      `HAPPY_CODEX_SYNC_V4_ENABLED`。
- [ ] 物理设备验收：
      App 扫码后显示新设备；`/v1/machines`、`/v1/sessions` 无 500；
      `happy codex` 无 401、P2023 或 `onFileEvent` 崩溃；v4 长流、状态、审批、
      compact/review、FIFO follow-up、child 和刷新恢复正常。
- [ ] 验收完成后归档本文件，并把活动计划切换到下一项真实未完成工作。

## 不变约束

1. 仅 Codex 使用 Sync v4；Claude 保持 v3。
2. Codex 最低 `0.145.0`，只使用 stable-v2。
3. Web 保持 HTTPS/localhost only。
4. 原生 HTTP 只用于显式可信网络；主动 MITM 下不承诺 token、ACK、服务身份、
   metadata 或零丢失。
5. 保持端到端加密；不得记录明文 prompt、raw reasoning、工具参数、输出或密钥。
6. 只推送 `origin`；不得 force。

## 变更记录

- 2026-07-30：R8 云端 CI、CLI 1.4.6 和 relay 1.1.24 制品完成并归档；活动
  计划缩减为现场升级和物理设备验收。
