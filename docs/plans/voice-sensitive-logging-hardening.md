# Voice 敏感日志收敛计划

## 状态

- 当前状态：进行中；实现、定向 canary 与源码类型检查已完成，等待集成分支 CI 后关闭 `LOG-01`。
- 优先级：高。生产文档已反映已实施的 payload-free 日志边界，最终关闭仍以云端 CI 为准。
- 范围：App、Server、Wire 测试与云端验证；不改变 ElevenLabs 必需的数据传输契约。

## 已核验证据

- `packages/happy-app/sources/realtime/voiceConfig.ts` 默认启用语音调试日志；
- `packages/happy-app/sources/realtime/hooks/voiceHooks.ts` 可记录完整 contextual update；
- `packages/happy-app/sources/realtime/RealtimeSession.ts` 记录 conversation 响应，
  其中 schema 包含 `conversationToken`；
- `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` 记录 Happy user ID、
  ElevenLabs conversation ID 与用量；
- `packages/happy-wire/src/voice.ts` 明确定义 App/Server 间必需的短期 token 和 provider ID。

## 待完成

- [x] 默认关闭 payload 级语音调试；生产构建只允许固定事件、布尔值、枚举和用量区间。
- [x] 删除或替换 App 对 conversation 响应、contextual update 和原始 SDK/Error 的完整日志。
- [x] Server 日志不记录 user/conversation/provider ID，只记录无 ID 的安全聚合字段。
- [x] 在 App 与 Server 各自建立白名单日志边界；不在 Wire 引入日志 API，避免扩大协议消费者版本。
- [x] 新增 logger capture canary：向语音响应、context 和 provider error 注入标记，断言日志不含标记。
- [x] 在 App/Server 受影响包递增 patch version：App `1.11.29`、Relay Server `1.1.41`。
- [x] 更新 [Voice Architecture](../voice-architecture.md) 和部署安全边界；待 CI 成功后归档本计划。

## 验收标准

- 默认和错误路径都不记录 conversation token、语音 context、消息历史、tool 参数、
  project path、Happy user ID 或 ElevenLabs/provider ID；
- 可观测性仍保留事件类型、成功/失败、时长、匿名聚合和配额区间；
- BYO 与 Happy-managed voice 都经过同一日志 canary 测试；
- 云端 CI 与对应 App/Server release workflow 全部通过。
