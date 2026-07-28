# Codex Sync v4 整改与发布计划

## 状态

- 分支：`codex/sync-v4`
- 基线提交：`8134959e5d1b63e03d615ab22fef7ec7a4f90fb5`
- 开始日期：2026-07-28
- 当前状态：实施中，`HAPPY_CODEX_SYNC_V4_ENABLED` 必须保持关闭
- 权威架构：`docs/decisions/ADR-001-codex-sync-v4.md`

本文件是本轮整改的执行基准。实现中发现新的事实、协议限制或测试失败时，
先更新本文件的范围、决策或验收条件，再修改代码。

## 已锁定决策

1. 仅 Codex 使用 Sync v4；Claude 保持 v3。
2. Codex 最低版本为 `0.145.0`，只使用 stable-v2，不启用 experimental API。
3. stable-v2 没有历史分页接口，因此迁移使用
   `thread/read(includeTurns=true)`，只对官方精确错误回退到
   `thread/resume`。不宣称支持不存在的 `thread/turns/list` 或
   `thread/items/list`。
4. HTTP 仅作为可信网络中的显式不安全模式。主动 MITM 下不承诺 ACK
   可信、零永久丢失、token 保密、服务端身份或流量元数据保护。
5. Web 保持 HTTPS/localhost only。HTTPS Web 页面不尝试连接 HTTP relay。
6. CLI、Android、iOS 和 Tauri 可以通过显式 `allowInsecureHttp` 使用
   HTTP relay；默认服务和默认配置仍使用 HTTPS。
7. provider child session 独立、隐藏、只读。写操作必须同时在 UI 和命令
   边界拒绝。
8. v4 发布开关只有在数据库、四包测试、协议模拟、规模测试和云端 CI
   全部通过后才能启用。
9. 安全依赖更新不得顺带改变 Codium/Claude 的依赖解析版本；Claude
   adapter 与 Sync v3 的运行路径保持在本轮范围之外。

## Prisma migration 授权与门禁

用户已于 2026-07-28 明确授权本轮代理创建正式 Prisma migration，
覆盖 `packages/happy-server/CLAUDE.md` 中“只能由人工创建 migration”的
项目默认限制。本轮必须：

- 创建 `Session.syncV4Seq`、`SessionEntityV4` 和
  `SessionMutationV4` 的正式 additive migration；
- 校验 schema 与 migration 的差异；
- 审查全部索引、唯一约束、外键和删除行为；
- 增加真实旧库升级与空库部署测试；
- 在 PostgreSQL 上验证 `prisma migrate deploy`，不得仅依赖生成的
  Prisma Client 或 PGlite。

migration 文件缺失、drift 检查失败或任一升级路径未验证时，发布门禁
仍必须失败。

## 整改工作流

### R1 Wire 与 Server

- [x] Sync v4 POST 路由使用约 5 MiB 独立 `bodyLimit`。
- [x] 认证和版本门禁在 `onRequest` 执行，先于 body 解析。
- [x] Wire 在字符串长度超限后不再执行完整 UTF-8 编码。
- [x] ACK、changes、snapshot 响应限制条数和聚合密文字节。
- [x] snapshot/changes 按“条数或字节先到”分页，transport 设置响应上限。
- [x] seq/revision/watermark 与数据库整数域一致。
- [x] 分页 schema 校验 watermark、连续性、游标长度和空页不变量。
- [x] journal payload 可清理，但紧凑 mutation receipt 长期保留幂等信息。
- [x] prune 与 410 检查使用一致数据库快照，或返回页后验证连续性。
- [x] Prometheus 标签只使用有界 client type/version bucket。
- [x] CORS 显式允许 `Authorization, Content-Type, X-Happy-Client`。
- [x] 使用稳定的 `/health` relay identity/health 与
  `/v4/capabilities` 协议能力端点。
- [x] 创建正式 Prisma migration，并执行 PostgreSQL 空库和旧库升级测试。

### R2 CLI 持久队列

- [ ] `enableSyncV4()` 使用单一 in-flight promise、closed/generation 检查。
- [ ] 每个 session journal 只有一个进程级 writer lease。
- [ ] journal 持久化结果不确定时 fail-stop，不继续分配 revision。
- [ ] outbound/inbound drain 有批次预算，持续流量下也会 compact。
- [ ] compact 依据可回收字节而非文件总大小，避免无收益周期重写。
- [ ] terminal command 仅保留紧凑 receipt，不永久保留完整 payload。
- [ ] command execution context 在 provider RPC 前持久化。
- [ ] 非幂等 RPC outcome unknown 时只协调，不自动重放。

### R3 Codex Gateway

- [ ] mapper 只在实体进入持久 outbox 后提交 published 状态。
- [ ] migration 建立 snapshot/live barrier，旧 snapshot 不得覆盖 live delta。
- [ ] `ready` mutation ACK 与本地 migration 状态通过可恢复的 activating
      状态协调。
- [ ] orphan notification 进入持久 FIFO，绑定失败可重试并最终 snapshot
      对账。
- [ ] 进程退出恢复所有 active thread，不依赖 selected thread。
- [ ] 区分 provider child、用户 fork、detached review 和 sibling 通信。
- [ ] turn/thread 状态单调，旧 turn 完成不能结束另一个 active turn。
- [ ] interrupt 超时只触发重连协调，不直接产生权威 completed/idle。
- [ ] resume 不使用陈旧配置放宽 approval/sandbox 权限。
- [ ] server request handler 总是返回 response 或协议 error。
- [ ] provider request 的 pending、response-ready、supplied、resolved 和
      outcome-unknown 状态可跨进程恢复。
- [ ] stable-v2 UserInput 和 ThreadItem 使用 exhaustive mapper；未知 stable
      variant 产生受控诊断而不是空 item。
- [ ] warning/error ID 跨重启不碰撞，错误码保持结构化。
- [ ] finalized stream 释放大内容，snapshot 批量投影避免重复发布。

### R4 App

- [ ] v4 client 启动失败后指数退避自动恢复，并显示 sync unknown。
- [ ] changes 在解密前分类为 new/exactReplay/superseded。
- [ ] snapshot 使用 shadow generation，完整验证后原子切换。
- [ ] 损坏的派生 MMKV index 可以由独立记录重建。
- [ ] entity、outbox 和 projection 使用分桶或增量索引。
- [ ] delta 只重投影受影响 item/turn，不全量重建历史。
- [ ] 同一 item 的每个 pending request 都可独立显示和操作。
- [ ] v4 token usage、connection、execution、approval、user-input 和
      subagent activity 接入 UI。
- [ ] child readOnly 贯穿 MessageView、ToolView、审批、用户输入和 MCP。
- [ ] command publish 边界再次拒绝 child 写操作和跨 owned-thread 目标。

### R5 HTTP 平台支持

- [ ] 设置模型增加显式 `allowInsecureHttp`，首次启用显示风险确认。
- [ ] CLI 对 HTTP 自定义 relay 输出一次清晰的安全降级提示。
- [ ] Android production 配置 cleartext，并在 CI introspection 中断言。
- [ ] iOS production 允许已确认的 HTTP relay，并在 CI 检查 ATS 结果。
- [ ] Tauri REST 使用受控 native transport；目标 origin 在 Rust/配置边界校验。
- [ ] Tauri capability 不再无条件放行 `http://**`，CSP 不保持全关闭状态。
- [ ] `happy server` 分离 bind URL、local URL 和 advertised `--public-url`。
- [ ] bundled Web App 默认使用 `window.location.origin`。
- [ ] Web 设置拒绝非 localhost HTTP，并解释浏览器限制。
- [ ] Socket.IO 与轮询分别验证；invalidation 丢失时仍能拉取恢复。

### R6 测试与 CI

- [ ] Wire：schema 正反例、响应字节预算、INT32、分页不变量、SemVer。
- [ ] Server：真实 PostgreSQL migration、并发 POST、prune/410、receipt。
- [ ] CLI：journal 每个崩溃边界、单 writer、持续流量和 unknown RPC。
- [ ] Gateway：snapshot/live、orphan FIFO、多 thread、fork/review/child、
      request 恢复和 stable variant 覆盖。
- [ ] App：启动重试、stale ciphertext、shadow snapshot、坏索引、child
      双层只读、多审批和 usage 恢复。
- [ ] 业务链路模拟：fake Codex app-server -> CLI -> relay -> App projection。
- [ ] Chaos：100,000 mutation 的重复、延迟、断网、丢 invalidation，最终
      snapshot 完全一致。
- [ ] 性能：10,000 entity + 5 Hz delta，健康本地链路 p95 < 750 ms。
- [ ] 长 turn：真实超过 10 分钟，虚拟时钟 2 小时不假结束。
- [ ] GitHub CI 覆盖 Wire、Server、CLI、App 的 typecheck、unit test 和 build。
- [ ] GitHub CI 覆盖 Agent 的 typecheck、unit test 和 build，并将 Codex
      provider、CLI transport、relay 路由和 App projection 的故障场景作为
      独立 required gate。
- [ ] GitHub CI 覆盖 Prisma migration drift、协议生成 drift 和业务链路模拟。
- [ ] Android release workflow 保留现有签名、ABI、OTA、SDK 和 16 KiB 检查。
- [ ] CLI release workflow 产出单一可安装 tgz 并验证内置工具归档。

## 发布顺序

1. 修复代码并保持 v4 Server flag 关闭。
2. 推进受影响包 patch 版本；本轮最低目标：
   CLI `1.4.3`、App `1.11.5`、Server `1.1.13`、Wire `0.1.2`。
3. 本地通过四包 typecheck、unit test、build、协议模拟和 migration gate。
4. 推送 `origin/codex/sync-v4`，等待所有 PR CI。
5. CI 失败时修复、再次推进受影响 patch 版本、提交并推送。
6. 全绿后先部署 flag 关闭的 Server，再发布匹配 CLI/App。
7. 确认没有旧版 Codex turn 后统一启用。

## 完成定义

- 已 ACK 的 mutation 在声明的 HTTPS/无主动 MITM 模型下零永久丢失。
- HTTP 模式在 UI/CLI 明确标为不安全，不宣称抵抗主动 MITM。
- 任一 CLI/App/Server 重启后队列、cursor、runtime 和 pending request 可恢复。
- 主 thread、多个 child、fork 和 review 的状态与消息流互不覆盖。
- `/compact`、review、skills、MCP、审批和 reasoning summary 可实时显示并恢复。
- 10k/100k、长 turn、崩溃和平台 HTTP 测试均纳入可重复命令及 CI。
- 云端所有必需检查和版本触发编译全部成功。

## 变更记录

- 2026-07-28：建立整改基线；锁定可信网络 HTTP、Web HTTPS/localhost 和
  stable-v2-only 决策。
- 2026-07-28：用户明确授权代理创建正式 Prisma migration；将原人工门禁
  改为代理创建、PostgreSQL 双路径验证和 drift 门禁。
- 2026-07-28：依赖漏洞修复保持 Codium 的 Claude Agent SDK 解析版本不变；
  全面 CI 增加 Agent 与跨组件 Codex 传输场景门禁。
- 2026-07-28：GitHub run `30330542959` 已通过 PostgreSQL 空库部署、旧库升级、
  drift、索引和级联门禁，R1 完成。首轮 CI 同时确认 pnpm script 会优先命中
  Codium 的 `codex 0.130.0`；协议生成门禁改为显式传入全局
  npm prefix 下的 `codex 0.145.0` binary，不改变 stable-v2 约束。
  dependency audit job 不启用无依赖安装场景下的 pnpm cache；CI、Smoke
  Test 和版本构建工作流统一使用 Node 24 runtime 对应的 action 版本。
