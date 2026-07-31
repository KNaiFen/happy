# Codex Sync v4 R8 现场升级与验收记录

## 归档状态

- 归档日期：2026-07-30
- 发布版本：CLI `1.4.6`、Server `1.1.24`
- 保持版本：App `1.11.11`、Wire `0.1.3`
- 代码、main CI 和云端制品已完成。
- 现场部署暴露出 R9 阻断故障，原“等待物理设备验收”结论不再成立。
- 后续修复与验收已完成，最终记录见
  `docs/plans/archive/codex-sync-v4-remediation-r12.md`。

## R8 原待办

- [x] 保留原 `.env`、master secret、named volume 和 v4 选择，原地升级 relay。
- [x] 安装 CLI `1.4.6`，停止旧 daemon，并针对新 relay 重新启动和配对。
- [x] 确认没有旧版正在运行的 Codex turn，再启用
      `HAPPY_CODEX_SYNC_V4_ENABLED`。
- [ ] 物理设备验收未通过：
      App 扫码后设备状态异常；新建 Codex v4 对话后消息与回复不投影；
      删除设备后遗留可交互会话；服务端曾输出敏感错误上下文。

## 现场结论

1. 普通用户和 root 启动的 CLI 均可复现“新会话存在但消息为空、无回复”。
   这不是 root 权限特例。
2. Relay 已持久化并可重放对应 v4 entity，故主要断点位于原生 App 的 v4
   client 启动和本地投影路径。
3. 设备删除只删除 Machine 行和 AccessKey，没有撤销终端凭据，也没有保留
   Session 与来源 Machine 的可验证关系，导致幽灵会话和旧 CLI 继续连接。
4. 后续 R9 必须同时修复同步启动、设备撤销、孤儿会话交互边界和日志脱敏，
   不能继续以现场配置问题处理。

## 不变约束

1. 仅 Codex 使用 Sync v4；Claude 保持 v3。
2. Codex 最低 `0.145.0`，只使用 stable-v2。
3. Web 保持 HTTPS/localhost only。
4. 原生 HTTP 只用于显式可信网络；主动 MITM 下不承诺 token、ACK、服务身份、
   metadata 或零丢失。
5. 保持端到端加密；不得记录明文 prompt、raw reasoning、工具参数、输出或密钥。
6. 只推送 `origin`；不得 force。
