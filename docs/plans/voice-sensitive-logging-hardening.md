# Voice 敏感日志收敛计划

## 状态

- 当前状态：进行中；真实性核验已完成，正在按审计台账 `LOG-01` 收敛 App 与 Server 的语音日志。
- 优先级：高。完成前不得在架构或隐私文档中宣称语音链路已经完全脱敏。
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

- [ ] 默认关闭 payload 级语音调试；生产构建只允许结构、计数和耗时。
- [ ] 删除或替换 App 对 conversation 响应与 contextual update 的完整日志。
- [ ] Server 日志对 user/conversation/provider ID 使用不可逆、进程外不可关联的安全摘要，
      或只记录无 ID 的聚合计数。
- [ ] 在 App 与 Server 各自建立白名单日志边界；不在 Wire 引入日志 API，避免扩大协议消费者版本。
- [ ] 新增 logger capture 测试，向语音响应和 context 注入 canary，断言 stdout/stderr、
      test logs 和错误路径均不出现 canary。
- [ ] 在 App/Server 受影响包递增 patch version，通过对应源码 CI 与发行工作流。
- [ ] 更新 [Voice Architecture](../voice-architecture.md) 和部署安全边界后归档本计划。

## 验收标准

- 默认和错误路径都不记录 conversation token、语音 context、消息历史、tool 参数、
  project path、Happy user ID 或 ElevenLabs/provider ID；
- 可观测性仍保留事件类型、成功/失败、时长、匿名聚合和配额区间；
- BYO 与 Happy-managed voice 都经过同一日志 canary 测试；
- 云端 CI 与对应 App/Server release workflow 全部通过。
