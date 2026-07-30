# Codex Sync v4 R8 发布与实机验收计划

## 状态

- 分支：`codex/sync-v4`
- 当前状态：分支 CI 全绿且已同步 main，等待发布工作流
- 目标版本：CLI `1.4.6`、Server `1.1.24`
- 保持版本：App `1.11.11`、Wire `0.1.3`
- 本地实现归档：
  `docs/plans/archive/codex-sync-v4-remediation-r8-local.md`
- 分支 CI 与 main 同步归档：
  `docs/plans/archive/codex-sync-v4-remediation-r8-branch-ci.md`
- R1-R7 归档：
  `docs/plans/archive/codex-sync-v4-remediation-r1-r7.md`

本文件只保留未完成事项。每完成一个阶段就把详细结果移入归档，避免活动上下文
持续膨胀。

## 不变约束

1. 仅 Codex 使用 Sync v4；Claude 保持 v3。
2. Codex 最低 `0.145.0`，只使用 stable-v2。
3. Web 保持 HTTPS/localhost only。
4. 原生 HTTP 只用于显式可信网络；主动 MITM 下不承诺 token、ACK、服务身份、
   metadata 或零丢失。
5. 保持端到端加密；不得记录明文 prompt、raw reasoning、工具参数、输出或密钥。
6. 现有 relay volume、master secret、`.env` 和 v4 选择必须原地保留。
7. 只推送 `origin`；同步 main 使用正常 push，禁止 force。

## 待完成

- [ ] 等待 main CI、CLI `1.4.6` release 和 relay `1.1.24` release 全绿。
- [ ] 下载并校验 `happy-1.4.6.tgz`、relay tarball 和 SHA-256。
- [ ] 保留原 `.env`、secret 和 named volume 升级 relay；不得 reset 或重新安装
      数据目录。
- [ ] 安装 CLI `1.4.6`，停止旧 daemon，重新启动。
- [ ] 物理设备验收：
      App 扫码后显示新设备；`/v1/machines`、`/v1/sessions` 无 500；
      `happy codex` 无 401、P2023 或 `onFileEvent` 崩溃；v4 长流、状态、审批、
      child 和刷新恢复正常。
- [ ] 验收完成后将 R8 发布记录移入归档，并把活动计划切换到下一项真实未完成工作。

## 本地结论

根因、实现和验证证据已经归档。当前本地门禁包括 CLI/Server 全量测试、
100,000 mutation chaos、精确旧 PGlite 卷读取和真实
Codex -> CLI -> HTTP relay -> App 场景；链路 p95 `236.4 ms`，production audit
为 `0 critical`。

## 变更记录

- 2026-07-30：R8 本地实现完成并归档；活动文件缩减为云端、发布和实机验收清单。
- 2026-07-30：51 个业务/计划文件完成 staged diff 审查；本地 `.agents` 和其他
  AI 文件均未暂存。
- 2026-07-30：提交 `64170a01` 的分支 required gate 全绿并正常同步 main；
  已归档该阶段。relay 1.1.23 release 在 ShellCheck 阶段停止且无制品，修复版
  推进到 1.1.24。
