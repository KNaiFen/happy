# Voice Architecture

> **当前文档（2026-08-05）：** Happy App 使用 ElevenLabs conversation 作为可选语音桥；
> 语音工具通过显式 `sessionId`/`requestId` 路由，不依赖全局焦点猜测目标。

## 组件

- App `sources/realtime/RealtimeSession.ts`：语音会话生命周期、当前焦点和上下文更新；
- App `sources/realtime/realtimeClientTools.ts`：客户端工具；
- App `sources/realtime/voiceSystemPrompt.ts`：系统提示与工具使用边界；
- Server `sources/app/api/routes/voiceRoutes.ts`：conversation token/usage 与配额；
- RevenueCat：默认 Happy 语音服务的订阅资格；
- ElevenLabs：实时语音传输与 agent runtime。

## 启动流程

1. 用户从一个 Happy session 启动语音。
2. App 生成经过裁剪的初始会话上下文和计数器。
3. App 请求 `POST /v1/voice/conversations`。
4. Server 核验用户、30 天用量、conversation 数和订阅资格，再返回 conversation token。
5. App 启动 ElevenLabs session，并通过 contextual update 批量发送后续状态变化。
6. 结束时 App 清理 conversation ID、开始时间和焦点状态。

`currentSessionId` 只表示语音界面的当前焦点和上下文来源。它不是消息工具的授权或路由
依据；切换页面不会把缺少目标 ID 的工具调用自动改发到另一个 session。

## 客户端工具

### `sendMessageToSession`

参数为 `{ sessionId, message }`。工具校验两个字段后直接调用
`sync.sendMessage(sessionId, message, { source: 'voice' })`。旧名称
`messageClaudeCode` 已移除。

### `processPermissionRequest`

参数为 `{ requestId, decision }`，其中 decision 只能为 `allow` 或 `deny`。App 在本地
session state 中查找实际拥有该 request 的 session，再调用对应 allow/deny 操作。
找不到 request 时显式失败，不回退到当前焦点。

## 上下文与隐私

初始 context 可包含当前 session ID、project path、summary、最近最多 50 条消息和运行计数；
后续 contextual update 可包含新消息、焦点/ready 状态、pending permission、tool name 与
arguments。初始 context 也会进入 voice system prompt。这些数据会发送给配置的 ElevenLabs
服务，因此不属于 Happy Relay 的端到端密文边界。用户使用 BYO ElevenLabs 时直接使用自己的
ElevenLabs 账户，并负责该服务配置与数据处理。

生产语音日志通过 App 与 Server 独立的白名单边界输出。日志只保留固定事件、成功/失败、
布尔决策、受限枚举和配额区间；不得记录 contextual update、prompt、conversation token、
user/conversation/provider ID、SDK 原始数据或 Error。App 默认关闭 SDK payload 调试。
实现与 canary 记录见
[Voice 敏感日志收敛计划](plans/voice-sensitive-logging-hardening.md)。

## 配额

Server 以滚动 30 天窗口统计 ElevenLabs conversation：

- 免费额度：`1,200` 秒（20 分钟）；
- 已订阅用户默认硬上限：`18,000` 秒（5 小时）；实现中可有明确的运营例外；
- 最多跟踪 `100` 个 conversation。

达到免费额度且没有有效订阅时拒绝新 conversation；即使订阅有效也受其适用硬上限约束。
具体错误结构与例外只以 `voiceRoutes.ts` 和 Wire schema 为准。

## 失败与恢复

- token/订阅/配额失败：不启动 conversation，并向用户显示可恢复错误；
- ElevenLabs 启动失败：重置 App voice state，不留下“已连接”状态；
- 工具参数错误或目标不存在：返回显式错误，不猜测 session；
- 页面切换：更新焦点和 context，但已经携带明确 ID 的调用仍发往指定目标；
- 网络中断：由 ElevenLabs/App 生命周期结束会话；不得把它解释为 Codex turn 完成。

原始配额方案保存在
[ElevenLabs Voice Usage Gating 归档](plans/archive/elevenlabs-voice-usage-gating.md)。
