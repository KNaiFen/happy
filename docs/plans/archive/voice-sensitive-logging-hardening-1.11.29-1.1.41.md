# Voice 敏感日志收敛计划

## 状态

- 当前状态：已解决；`LOG-01` 已在集成分支完成实现、独立复核和云端 CI 验收。
- 解决版本：App `1.11.29`、Relay Server `1.1.41`；最终统一发行版本由总台账继续管理。
- 范围：App、Server、Wire 测试与云端验证；不改变 ElevenLabs 必需的数据传输契约。

## 已核验证据

- `packages/happy-app/sources/realtime/voiceConfig.ts` 默认启用语音调试日志；
- `packages/happy-app/sources/realtime/hooks/voiceHooks.ts` 可记录完整 contextual update；
- `packages/happy-app/sources/realtime/RealtimeSession.ts` 记录 conversation 响应，
  其中 schema 包含 `conversationToken`；
- `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` 记录 Happy user ID、
  ElevenLabs conversation ID 与用量；
- `packages/happy-wire/src/voice.ts` 明确定义 App/Server 间必需的短期 token 和 provider ID。

## 已完成工作

- [x] 默认关闭 payload 级语音调试；生产构建只允许固定事件、布尔值、枚举和用量区间。
- [x] 删除或替换 App 对 conversation 响应、contextual update 和原始 SDK/Error 的完整日志。
- [x] Server 日志不记录 user/conversation/provider ID，只记录无 ID 的安全聚合字段。
- [x] 在 App 与 Server 各自建立白名单日志边界；不在 Wire 引入日志 API，避免扩大协议消费者版本。
- [x] 新增 logger capture canary：向语音响应、context 和 provider error 注入标记，断言日志不含标记。
- [x] 在 App/Server 受影响包递增 patch version：App `1.11.29`、Relay Server `1.1.41`。
- [x] 更新 [Voice Architecture](../../voice-architecture.md) 和部署安全边界，并在 CI 成功后归档本计划。

## 关闭证据

- 实现提交：`4f6ea58e83f69e29162f0f4512ceb56904785c4a`；发布矩阵同步提交：
  `17c23a97e293e086e6cf49355bd065e9ef940b0b`。
- App canary：`voiceLog.spec.ts` 与 `voiceTracking.spec.ts` 共 3 项通过；App 全量 typecheck 通过。
- Server canary：`voiceRoutes.spec.ts` 4 项通过，覆盖成功、token 请求异常、用量请求 reject
  和非 2xx fail-closed；本地 typecheck 仅受工作区既有 `@octokit/webhooks` 缺失阻断。
- GitHub Actions：`Happy monorepo CI` run `31052901664` 全部通过，包括 App、Server、Wire、
  依赖审计、官方 Codex app-server 生命周期和真实 TUI Gateway 往返。
- `Documentation knowledge base` run `31053102538` 通过；知识库共校验 146 个 Markdown/MDX 文件。

## 验收标准

- 默认和错误路径都不记录 conversation token、语音 context、消息历史、tool 参数、
  project path、Happy user ID 或 ElevenLabs/provider ID；
- 可观测性仍保留事件类型、成功/失败、时长、匿名聚合和配额区间；
- BYO 与 Happy-managed voice 都经过同一日志 canary 测试；
- 云端 monorepo CI 全部通过；App/Server release workflow 随总台账最终合入 `main` 后统一执行。
