# happy-wire

`@slopus/happy-wire` 是 App、CLI、Server 和 happy-agent 共享的协议 schema/type 包。
当前版本见自动生成的 [发行矩阵](release-matrix.md)。

## 当前模块

`packages/happy-wire/src/index.ts` 只导出以下边界：

- `messages.ts`：共享消息、update 与兼容 payload schema；
- `controlMessages.ts`：控制面消息；
- `voice.ts`：语音请求/响应类型；
- `syncV4.ts`：mutation、ACK、change、snapshot 与 capability；
- `syncV4Entities.ts`：Codex Sync v4 实体；
- `syncV4Diagnostics.ts`：不含 payload 的诊断结构。

业务规则、provider SDK 和持久化实现不进入 Wire。Codex 新能力必须先判断是否改变跨包契约；
只属于单一消费者的类型应留在该包。

## 依赖模型

所有 monorepo 消费者使用 `"@slopus/happy-wire": "workspace:*"`。这保证本地类型与 schema
始终来自同一 workspace 源码，不再用旧的 `^0.1.0` 模拟已发布包。

Wire/protocol 变更会影响所有消费者。完成可分发行变更时，应同步递增 Wire 与受影响消费者的
patch version，并在云端构建完整兼容集合；仅文档、测试或 CI 改动不递增版本。

## 兼容与安全

- Codex 的规范协议是 Sync v4 entity/mutation 模型；
- v1/v2/v3 schema 仅为仍在使用的共享基础设施和历史数据保留；
- schema 添加优先保持 additive；破坏性变更必须有迁移、ADR 和跨包测试；
- `syncV4Entities.ts` 描述客户端加密前的 Codex entity schema，因此可以包含 provider ID、prompt、
  tool arguments/output 和 command result；它们必须只作为 `SyncMutationV4.ciphertext`
  内部内容传输，不得出现在 mutation 元数据、诊断或日志中；
- `voice.ts` 另有明确边界：它会在 App/Server 间传输短期 `conversationToken`、
  `conversationId`、`agentId` 与 pseudonymous ElevenLabs user ID。这些字段不可写入日志；
- 只有官方 reasoning summary 可进入同步实体。

## 验证与发行

源码检查使用 package 的 `typecheck` 和测试。构建型验证在 GitHub Actions 完成。
Wire 当前不作为独立用户制品交付；happy-agent 打包工作流会同时 pack 并安装 Wire 归档，
其他消费者工作流也会先构建 Wire。

不得恢复旧的 `yarn release`、本地 `release-it` 或手工 npm 发布流程。当前制品、版本和
工作流入口见 [发行矩阵](release-matrix.md)。
