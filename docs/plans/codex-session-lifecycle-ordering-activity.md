# Codex 会话生命周期、时间线与活动显示修复

## 状态

进行中，2026-07-31。

## 已确认边界

- 仅 Codex 使用新的聊天内活动行；Claude 保持现状。
- Codex 业务阶段不做延迟或防抖。turn、item、MCP、工具、回复、审批和错误事件到达后立即投影。
- transport 连接状态与 provider execution 状态正交。断连不能把最后已知为 active 的 turn 改成 idle、completed 或 offline。
- active turn 没有真实 MCP、工具或流式回复可见时显示“思考中…”。真实内容出现时立即替代活动行；真实内容结束且 turn 仍 active 时立即恢复活动行。
- 归档由 relay 持久状态决定，App 立即隐藏会话；停止 CLI 是有界、后台的 best-effort 操作。
- Codex stable-v2 通知进入 CLI 的顺序是实时 item 排序依据，不用 App、CLI 或 relay 的墙钟猜测顺序。

## 实施顺序

1. Server 增加可空 `Session.archivedAt` 及纯新增 Prisma migration。归档幂等设置 tombstone，心跳和所有写入口不得复活或修改已归档会话；历史读取仍可用。
2. 增加仅原始终端机器凭据可调用的幂等 unarchive API，供 CLI 显式恢复原会话。App 的归档入口统一为服务端优先、按 session 去重的协调器，CLI kill 最长等待 5 秒且不决定归档成败。
3. Wire 为 `codex.item` 增加可选的 turn 内 `eventSequence`。CLI mapper 在 item 第一次进入串行通知管线时分配，snapshot 导入按稳定 fixture 验证的历史顺序初始化；后续 revision 不重排。
4. App projection 在同一 Codex turn 内优先使用 `eventSequence`，并让分组逻辑优先使用 provider turn ID，修复快速 MCP 被归入上一条用户消息的问题。
5. 修复 root thread 路由注册窗口：先发布内存绑定，再持久化；持久化失败时回滚并保留可重放通知。
6. App 增加不入库的 Codex 活动行。网络连接仅更新 connection 轴；重连补拉官方状态后才校准 execution。移除 Codex composer 的随机工作词。
7. 增加跨 Codex app-server、CLI journal/mapper、HTTP relay 和 App projection 的场景测试，并把断连抖动、快速 MCP、陈旧 heartbeat 和路由持久化延迟加入必需 CI。

## 验收门槛

- 归档 HTTP 成功后会话立即消失，旧 socket、排队 heartbeat 和 v4 outbox 均不能使其复活。
- 同一 turn 中用户消息始终排在随后发生的 MCP、工具和回复之前，重启和 snapshot 后顺序不变。
- active turn 在任意次数的断连和重连之间持续显示最后活动阶段，不闪为无活动或离线。
- 官方 MCP、工具、回复、审批、错误和完成事件均无额外 1.5 秒延迟。
- thread/start 响应与首批通知交错时零 canonical entity 丢失。
- Wire、CLI、Server、App 的测试、类型检查和真实 HTTP 场景全部通过；不在本地运行 Cargo/Tauri 构建。

## 发布

预期从当前版本推进 CLI `1.4.10`、App `1.11.17`、Server `1.1.31`、Wire `0.1.4`。若任一版本在实施期间已经运行过发行工作流，则继续递增 patch，不复用版本。
