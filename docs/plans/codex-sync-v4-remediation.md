# Codex Sync v4 当前交付状态

R9 原生同步启动、终端凭据、设备删除和孤儿会话只读修复已完成并发布：

- CLI `1.4.7`
- App `1.11.12`
- Server/relay `1.1.27`
- Wire `0.1.3`

完整实现、测试、CI 与发行证据已归档到：

`docs/plans/archive/codex-sync-v4-remediation-r9-device-lifecycle.md`

## 待实体设备复验

- 普通用户与 root 启动的 Codex v4 会话均实时显示用户消息、assistant 回复、
  长时间 execution 状态、审批和刷新恢复。
- 删除设备后旧 CLI 与 socket 立即失效；已有会话保持可读、可归档、可删除，
  但不能继续发送或批准操作。
- Android `1.11.12` 覆盖安装后验证扫码设备列表、会话恢复、子会话导航和
  HTTP 可信网络显式启用行为。
