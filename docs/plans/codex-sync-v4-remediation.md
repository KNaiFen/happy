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

- [x] `enableSyncV4()` 使用单一 in-flight promise、closed/generation 检查。
- [x] 每个 session journal 只有一个进程级 writer lease。
- [x] journal 持久化结果不确定时 fail-stop，不继续分配 revision。
- [x] outbound/inbound drain 有批次预算，持续流量下也会 compact。
- [x] compact 依据可回收字节而非文件总大小，避免无收益周期重写。
- [x] terminal command 仅保留紧凑 receipt，不永久保留完整 payload。
- [x] command execution context 在 provider RPC 前持久化。
- [x] 非幂等 RPC outcome unknown 时只协调，不自动重放。

R2 实施约束：

- `enableSyncV4()` 的创建、handler 安装和 start 共用同一个 promise；session
  close 必须使尚未完成的创建失效，并立即停止已经创建但尚未发布的 client。
- journal 使用每个 session 独立的原子 lock file，记录 PID 与随机 lease ID；
  活进程持有时拒绝第二个 writer，崩溃遗留且 PID 已不存在时才回收。release
  前必须等待已进入 journal lock 的写入完成，并校验 lease ID 后删除 lock。
- 任一 append/fsync/close 结果不确定都会 poison 当前 journal；当前实例之后
  的 revision 分配与写入全部失败，只有重新 open 并重放磁盘记录才能恢复。
- 后台 outbound drain 每轮最多处理固定批数并重新 invalidate；显式 flush
  只保证调用时已存在的 mutation 全部 ACK，不追赶之后产生的 mutation。
  inbound pull 固定本轮首次观察到的 high watermark，不无限追赶新增 change。
- 长 drain 定期让出事件循环并检查可回收字节；只有累计可回收 JSONL 字节
  达到阈值才 compact。终态 command 只保留 commandId、status 与时间 receipt，
  不在 compact 后保留完整 command payload。

### R3 Codex Gateway

- [x] mapper 只在实体进入持久 outbox 后提交 published 状态。
- [x] migration 建立 snapshot/live barrier，旧 snapshot 不得覆盖 live delta。
- [x] `ready` mutation ACK 与本地 migration 状态通过可恢复的 activating
      状态协调。
- [x] orphan notification 进入持久 FIFO，绑定失败可重试并最终 snapshot
      对账。
- [x] 进程退出恢复所有 active thread，不依赖 selected thread。
- [x] 区分 provider child、用户 fork、detached review 和 sibling 通信。
- [x] turn/thread 状态单调，旧 turn 完成不能结束另一个 active turn。
- [x] interrupt 超时只触发重连协调，不直接产生权威 completed/idle。
- [x] resume 不使用陈旧配置放宽 approval/sandbox 权限。
- [x] server request handler 总是返回 response 或协议 error。
- [x] provider request 的 pending、response-ready、supplied、resolved 和
      outcome-unknown 状态可跨进程恢复。
- [x] stable-v2 UserInput 和 ThreadItem 使用 exhaustive mapper；未知 stable
      variant 产生受控诊断而不是空 item。
- [x] warning/error ID 跨重启不碰撞，错误码保持结构化。
- [x] finalized stream 释放大内容，snapshot 批量投影避免重复发布。
- [x] command 与 payload 同时声明 thread target 时必须一致，ownership 校验
      与实际 RPC 不得使用不同优先级。
- [x] child 的 thread-scoped 只读查询不得省略 thread target 后回退到
      app-server 全局 selected thread；`mcp.status.list` 必须显式命中该
      child，只有真正全局的 skills/model 查询可无 thread。
- [x] Happy Server 初始离线、provider 已创建 root thread 后再绑定 v4 时，
      必须登记 route 并通过 snapshot/live barrier 导入既有历史。
- [x] 初始离线重连只有在 v4 binding/migration 完成后才算成功；失败必须关闭
      临时 session 并进入既有无限退避，不得留下无 Router 的假在线状态。
- [x] 持久 route 的 `activeTurnId=null` 必须清除内存旧 active turn，避免迟到
      completion 错误阻断后续 relation 收敛。
- [x] child relation 与 route 的跨 journal 提交顺序必须可恢复：active 先写
      route，terminal 先写 relation，任一边界崩溃后 snapshot 都能收敛。
- [x] parent `spawnAgent` 首次登记的 child route 必须持久化为 `starting`；
      即使尚无 child notification/orphan，CLI 重启也必须主动读取官方
      snapshot 并恢复 child binding。
- [x] Router 必须等待 Mapper 将 live notification 投影写入 durable outbox；
      Mapper 异步失败不得只记内部错误，必须转存 durable orphan 后重放。
- [x] 同一 thread 一旦存在 durable orphan，后续 live notification 必须先
      追加到同一 FIFO 再投影；不得越过失败记录造成 started/completed 或
      active/idle 顺序反转。
- [x] Router close 即使 flush 失败也必须关闭所有 child binding/socket，并在
      清理完成后再向调用方保留原错误。
- [x] provider RPC 成功且 route 已提交、commandResult 未提交的崩溃边界，
      必须通过 route 中的 coordinated commandId 恢复成功；没有该 receipt
      时继续 outcome-unknown/notReplayed，绝不猜测或重放非幂等 RPC。
- [x] app-server 在 thread/review RPC 响应后同一 stdout chunk 内立即发送
      provider request 时，Router 必须等待并发 route 登记后再绑定；等待
      仍未形成权威 route 才返回协议错误，不得把真实 root/review 请求误拒绝。
- [x] 尚未创建或登记任何 thread 的 root binding 仍必须接收 connection
      变化、pending request 断连处理和 flush，不能因 route map 为空而漏状态。
- [x] CLI 在计算 opaque ID 和加密前必须用 Wire canonical schema 校验出站
      entity；不得让只满足 TypeScript 静态类型、但运行时越界或结构无效的
      provider 数据进入 durable outbox，随后在 App 解密投影时永久卡住 cursor。

R3 实施顺序与状态机：

```txt
官方 snapshot/live notification
│
├─ ThreadRouter
│  ├─ 已绑定 thread -> per-thread FIFO
│  └─ 未绑定 thread -> durable orphan FIFO -> hydrate/classify -> replay
│
├─ CodexSyncV4Mapper
│  ├─ build next entity/part state
│  ├─ persist mutation into SyncV4 outbox
│  └─ only then commit in-memory published/state markers
│
└─ App projection
   └─ entity revision decides in-place replacement
```

```txt
migration local state
pending -> importing -> activating -> ready
                        │
                        ├─ persist activating locally
                        ├─ publish runtime(syncState=ready)
                        ├─ wait until ready mutation ACK
                        └─ persist ready locally

restart at activating
└─ flush existing outbox -> republish ready if needed -> ACK -> persist ready
```

R3 第二切片按以下权威恢复流实现：

```txt
app-server unexpected exit
│
├─ CodexThreadRegistry.activeThreadIds()
│  └─ pending start、inProgress turn 或 thread.status=active 全部纳入
│
├─ 单次 transport restart + initialize
│
├─ 对每个 active thread 顺序 thread/resume
│  ├─ approvalPolicy = on-request
│  ├─ sandbox = read-only
│  ├─ 不复用旧 permissive approval/sandbox defaults
│  └─ 不改变 selectedThreadId
│
├─ 恢复原 selectedThreadId
└─ 只由 resume snapshot、thread/status/changed 或 turn/completed
   协调每个 turn；缺少权威终态时继续 statusUnknown
```

```txt
interrupt grace timeout
│
├─ 不调用 settleForcedInterrupt()
├─ 不合成 turn_aborted / completed / idle
├─ restart app-server + conservative thread/resume
├─ snapshot turn.status = interrupted -> authoritative aborted
├─ snapshot/status 仍为 active          -> 保持等待并继续协调
└─ resume 失败或缺少目标 turn          -> statusUnknown，不宣称 force-stopped
```

状态合并约束：

- terminal turn 不得被迟到的 `inProgress` snapshot 回退；
- 较旧 `thread.updatedAt` snapshot 不得覆盖较新的 thread status；
- 旧 turn 完成只能结算自己的 completion，不能清除另一个 active turn；
- `turn/start` 仍 pending、尚无 turn ID 时，interrupt 协调结果必须读取同一
  registry completion，不得从恢复前的空 turn ID 推断；
- 直接 stable-v2 `thread/status/changed` 和 `turn/completed` 仍是权威边界；
- 自动恢复只收紧权限；用户发起的显式 resume 继续使用显式参数。

R3 第三切片使用以下 provider request 持久状态机：

```txt
server request received
│
└─ pending
   ├─ App response validated + fsync      -> responseReady
   │  ├─ stdin write callback + fsync     -> responseSupplied
   │  │  ├─ serverRequest/resolved        -> resolved
   │  │  └─ disconnect/crash              -> outcomeUnknown
   │  └─ disconnect/crash                 -> outcomeUnknown
   ├─ provider resolves before App reply  -> resolved
   └─ process restart before App reply    -> resolved(error)
```

实现约束：

- `responseReady` 必须在唤醒 app-server response writer 前 fsync；
- `responseSupplied` 只在 stdin write callback 成功后提交；但
  `responseReady` 恢复时仍按 outcome unknown 处理，因为崩溃可能发生在
  write 与 callback 之间；
- `serverRequest/resolved` 是 provider ACK；ACK 早于 write callback 时先缓冲，
  不得提前向 App command 返回成功；
- `resolved` 和 `outcomeUnknown` 必须与最终 request entity mutation 原子写入
  journal，崩溃后不得重放响应；
- managed handler 在写 response 前失败时返回 payload-free JSON-RPC
  `-32000`；未知 server request 返回 `-32601`，不得回空成功对象；
- response 已写入后发生本地持久化失败时不得再发送第二个 JSON-RPC response，
  只能进入 outcome unknown/fail-stop。

R3 第三切片本地门禁：CLI typecheck/build 通过，`99` 个测试文件、
`946/946` 单元测试通过；其中定向 `85/85` 覆盖五态顺序、每个响应写入
边界、旧 journal 兼容、handler 失败、未知方法和禁止二次 response。

R3 第四切片按以下持久路由与分类规则实现：

```txt
首次看到未绑定 thread 的 notification
│
├─ root session journal fsync orphanEnqueued
├─ 按该 thread 的 journal FIFO 顺序 hydrate + classify
├─ 建立或恢复目标 binding
├─ mapper 应用 notification，并将产生的 mutation fsync 到 outbox
└─ root session journal fsync orphanCompleted
```

- orphan 记录包含随机持久 ID、thread ID、接收时间和 canonical stable-v2
  notification JSON；完成记录只引用持久 ID。raw reasoning delta 不入队，
  thread/turn/item snapshot 中的 reasoning `content` 在落盘前剥离，只保留
  reasoning summary。compact 只保留未完成 orphan，截断尾行沿用 Sync v4
  journal 的恢复规则。
- 每个 thread 的 orphan 严格 FIFO；绑定、hydrate 或 projection 失败时不得
  删除原记录。失败使用有上限的指数退避重试，进程重启时先重放 journal，
  后续官方 snapshot 仍作为权威状态对账。
- 持久 notification ID 作为 warning/error/unknown-variant 诊断的幂等种子；
  mutation 已落 outbox 但 completion 尚未 fsync 时重放，不得生成第二张诊断
  item。root/user fork 在重放非 snapshot orphan 前先 hydrate 官方 snapshot。
- journal 同时保存 thread route classification，避免 detached review 或
  user fork 在“RPC 已成功、进程尚未完成通知路由”边界崩溃后失去归属。
- child route 同时保存最后 relation status 与 active turn ID。CLI 重启时
  只对 `starting/active` route 读取官方 snapshot 并恢复 child binding，
  不扫描或打开全部历史 child session；snapshot 的新权威状态回写 route。
- 恢复旧会话时必须先建立 mapper migration barrier，再注册 root route 或
  重放 orphan；否则恢复通知会先进入投影，随后被官方迁移 snapshot 覆盖。
- 新 Router 必须先成为 runtime 当前实例并安装 stable notification、
  server request 和 connection handler，再恢复持久命令与 orphan。relay
  重连窗口不得让仍在运行的 turn 或审批落到空 handler。
- Sync v4 client 启动拉取到的 command 必须先以 `received` 状态持久化，
  在 Router 就绪前暂停执行。root 与 child binding 都只能在 route ownership
  可用后恢复命令，避免启动、fork、review 或无 thread 的 `turn.start`
  已在 provider 成功但本地没有 route。
- 命令目标校验同时读取 command/payload 的有效 thread ID。root binding
  只允许已持久化的 root/user-fork route、初始 owned thread，以及显式
  `thread.resume` 的新归属；child binding 只允许自己的 thread。无 thread
  的 `turn.start` 成功后必须登记 root route，user fork 后续命令不得再被
  单一 `ownedThreadId` 错误拒绝。
- child binding 的命令白名单只包含 `thread.read`、`skills.list`、
  `mcp.status.list` 和 `model.list` 查询；`request.resolve` 会改变 provider
  状态，必须与 turn、审批、用户输入及 MCP response 写操作一起拒绝。
- provider RPC 已成功但 route 或 metadata 协调失败时，command 必须进入
  outcome-unknown，不得错误标记为普通 failed，也不得自动重放非幂等调用。
- JSONL stdout 的多行由 Node readline 同步派发，而请求 Promise 的续体在
  microtask 中执行；因此 provider request 绑定遇到“权威 root/review route
  即将由同一 RPC 续体登记”时，允许做有界 route-registration 协调等待。
  该等待只保护 JSON-RPC 派发竞态，不得作为 turn 完成超时；超时后仍必须
  返回协议错误，且不能把未知无 parent thread 猜成 root。
- root 只能由显式 `thread/start`、`thread/resume` 或当前会话发起并确认的
  `thread/fork` 注册。未知且没有 `parentThreadId` 的 thread 不得自动成为
  root。用户 fork 继续归属当前可写 Happy session，不建立 child relation。
- provider child 必须由官方 `source.subAgent.thread_spawn` 与
  `parentThreadId` 一致地证明，或由当前 parent 的 `spawnAgent`
  collaboration item 预先登记。`sendInput`、`resumeAgent`、`wait`、
  `closeAgent` 的 receiver 只是通信目标，不产生父子关系；
  `subAgentActivity` 也不单独推断 lineage。
- inline review 的 `reviewThreadId` 等于原 thread，继续使用原 binding。
  detached review 只由 `review/start` 的返回值登记 parent，并创建独立、
  隐藏、只读 side session；单凭 `source.subAgent.review` 不猜 parent。
- route 持久化、lineage 合并和 relation 首次发布、补全、生命周期状态更新
  必须使用同一串行临界区，覆盖 child snapshot、parent `spawnAgent` item
  与 child completed 交错到达的竞态。已登记 child 的官方
  `parentThreadId`/`source` 不得与持久 route 冲突。
- relation 维护每个 child 的当前 active turn；迟到的旧
  `turn/completed` 只能更新该 turn 的实体，不得把已有新 active turn 的
  relation 或父 runtime `activeSubagentCount` 改成 completed。
- mapper 对 `UserInput` 和 `ThreadItem` 使用编译期 exhaustive switch；
  runtime 未知 variant 生成不含原始 payload 的受控诊断。raw reasoning
  仍只在 CLI diagnostics 计数；正文、分段数和字节数均不进入 entity、
  part、journal 或日志。
- reasoning snapshot 写入 orphan journal 时按 0.145.0 stable-v2 字段白名单
  重建，只保留 `type`、`id` 和 summary，并清空 content；不得通过对象展开
  保留未来新增或未验证的 raw 字段。
- warning/error item 使用随机稳定长度 ID，避免进程重启后序号复用。
  error part 和 item arguments 保留官方 message、code、details 与
  `willRetry`，同时不记录明文到日志。
- finalized stream 在 mutation 持久化后立即删除正文和 chunk；只保留有界
  LRU completion marker，超限淘汰旧 marker。snapshot 导入每个 thread
  只发布一次 thread/runtime 基线，逐 turn 导入不得重复发布这两个实体。

R3 分为四个可独立验证的提交：

1. mapper durable publication boundary、迁移 `activating` 恢复和
   snapshot/live barrier；
2. thread/turn 单调状态、全部 active thread 恢复、interrupt 权威协调和
   conservative resume policy；
3. provider request 五态持久恢复，以及 server request 必答/协议错误；
4. orphan durable FIFO、provider child/user fork/detached review/sibling 分类、
   stable-v2 exhaustive item/input mapper、诊断 ID 与 stream/batch 内存治理。

R3 第四切片本地门禁：CLI typecheck/build 通过，`101` 个测试文件、
`993/993` 单元测试通过；其中 `10` 个定向文件、`127/127` 覆盖
crypto/client canonical 门禁、durable orphan FIFO、
route/lineage 恢复、启动门禁、动态 ownership、child 只读、迟到 turn、
reasoning 脱敏、结构化诊断和 stream/batch 内存治理。

### R4 App

- [x] v4 client 启动失败后指数退避自动恢复，并显示 sync unknown。
- [x] changes 在解密前分类为 new/exactReplay/superseded。
- [x] snapshot 使用 shadow generation，完整验证后原子切换。
- [x] 损坏的派生 MMKV index 可以由独立记录重建。
- [x] entity、outbox 和 projection 使用分桶或增量索引。
- [x] delta 只重投影受影响 item/turn，不全量重建历史。
- [x] 同一 item 的每个 pending request 都可独立显示和操作。
- [x] v4 token usage、connection、execution、approval、user-input 和
      subagent activity 接入 UI。
- [x] child readOnly 贯穿 MessageView、ToolView、审批、用户输入和 MCP。
- [x] command publish 边界再次拒绝 child 写操作和跨 owned-thread 目标。
- [x] child 不显示 fork/duplicate 入口，`forkAndSpawn` 最终执行边界也必须
      拒绝 provider child，不能依赖 UI 隐藏。
- [x] child 不显示 resume/archive/delete 等生命周期操作；
      resume/kill/archive/delete 最终边界拒绝 provider child，关闭 side
      panel 只能隐藏 child 视图，不得向共享 CLI 发送 `killSession`。
- [x] 当前 thread/runtime/usage/messages 只由加密 metadata 中的
      `codexThreadId` 选择；同一 Happy session 内旧 root/user-fork 的迟到
      mutation 只能更新 entity cache，不得夺回当前 UI 或执行状态。
- [x] 当前 runtime 在 reset/snapshot 切换边界暂时缺失时保留最后 execution
      并标记 `statusUnknown=true`，不得保留伪权威状态或自动变 idle。
- [x] prompt/steer 的 active turn 与审批 request 必须分别按
      `(ownedThreadId, turnId)`、`(ownedThreadId, requestId)` 对账，不能让旧
      thread 中相同或较新的标识抢占当前操作。
- [x] part/item delta 在 runtime 未变化时不得克隆 Session 或重建顶层会话
      列表，避免 5 Hz 流式输出放大为全局列表重渲染。

R4 分为三个可独立验证的提交：

1. App client 与 MMKV 持久状态机：
   - registry 持有 desired session，不依赖下一次 session refresh 才重试；
   - 启动失败进入有上限且带抖动的指数退避，前台恢复和 socket 重连可提前
     唤醒；本地 projection 明确区分 `starting/ready/retrying/unknown`；
   - changes 在解密前顺序分类为 `new/exactReplay/superseded`。同 revision
     但 ciphertext、op 或 entity metadata 不一致必须 fail closed；
   - superseded 只消费 seq，不解密或投影；exact replay 不重复写 cache，但在
     cursor 尚未推进时允许幂等重投影，覆盖“cache 已写、projection 未完成”
     的崩溃边界，最终由 entity revision 去重；
   - snapshot 写入独立 generation。全部分页、解密、schema 和 watermark
     校验通过后，先通过单次 store transaction 替换 UI projection，再以
     generation pointer 提交 cache/cursor；构建失败时旧 cache 和旧 UI 保留；
   - entity/outbox index 使用固定分桶。派生 index 损坏时从独立 record
     扫描重建，只有独立 outbox record 损坏才 fail closed。
2. 增量 projection 与结构化状态：
   - 建立 item/turn/part/request/relation/command 的增量反向索引；
   - part delta 只重建所属 item message，turn 变化只重建该 turn 的 item，
     不再遍历和排序全部历史 entity；
   - message 通过稳定 ID 原位替换，并以增量有序列表维护显示顺序；
   - 同一 item 的多个 request 使用各自稳定 message/control ID，不共享
     `requests[0]`；每个 pending request 均可独立结算；
   - thread/turn token usage 映射到 composer/status bar；connection、
     execution、approval、user-input、subagent activity 和本地 sync health
     保持独立，不回退为单一 thinking 真值。
3. child 双层只读与 UI：
   - provider child 继续使用真实、隐藏的 side session；
   - `SessionView`、`MessageView`、`ToolView`、审批、用户输入、MCP、
     goal/mode/interrupt 控件全部读取统一 readOnly capability；
   - `publishCodexV4Command` 在持久 outbox 前再次校验 session ownership、
     readOnly 和 command/payload thread target；UI 漏网也不能产生 mutation；
   - fork/duplicate 在 quick actions、DuplicateSheet 和 `forkAndSpawn`
     最终执行边界拒绝 provider child；
   - resume/archive/delete 在详情与 quick actions 中隐藏，
     resume/kill/archive/delete 最终边界拒绝 provider child；provider child
     关闭仅改变本地 panel 状态；
   - projection 以 `metadata.codexThreadId` 选择当前 thread/runtime/usage 和
     message stream；metadata 选择改变时允许一次全量重投影，普通旧 thread
     delta 不得触发当前 message list 替换；
   - parent delegation 卡片仅导航 child，child 完成只更新自己的 projection。

R4 client/snapshot 权威提交顺序：

```txt
changes page
│
├─ validate contiguous seq + classify metadata
├─ new only: decrypt + canonical entity validation
├─ persist changed entity records
├─ atomically apply affected projection messages
└─ persist receive cursor
```

```txt
snapshotRequired
│
├─ begin shadow generation (old generation remains active)
├─ page loop: validate -> decrypt -> persist shadow records
├─ build replacement projection + optimistic outbox
├─ one store transaction swaps visible projection
├─ write shadow cursor
├─ atomically switch active generation pointer
└─ delete marker and lazily reclaim old generation
```

R4 本地门禁至少包括：App typecheck/build、App 全量 unit、client/persistence
逐写入边界崩溃测试、snapshot 中途失败保持旧视图、坏 index 重建、相同
revision 冲突、10,000 entity 增量投影计数、同 item 多 request，以及 child
从 UI 事件到 outbox 的双层只读测试。

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
- 2026-07-28：R3 第二切片完成全部 active thread 的保守恢复、selection
  隔离、turn/thread 单调合并和 interrupt 权威协调；`turn/interrupt` 的
  `{}` ACK 不再被视为终态，pending start 也通过 registry completion 对账。
- 2026-07-28：R3 第三切片细化 provider request 为 pending、
  responseReady、responseSupplied、resolved 和 outcomeUnknown 五态；
  unknown/失败的 server request 必须返回 JSON-RPC error。
  dependency audit job 不启用无依赖安装场景下的 pnpm cache；CI、Smoke
  Test 和版本构建工作流统一使用 Node 24 runtime 对应的 action 版本。
- 2026-07-28：R3 第四切片锁定 durable orphan journal 与完成边界；
  root/user fork、provider child、detached review 和 sibling communication
  使用显式 route classification，禁止根据无 parent 的未知 thread 猜 root，
  并增加 exhaustive stable-v2 projection、结构化诊断及有界 stream marker。
- 2026-07-28：R3 第四切片提交前审查发现恢复顺序、启动期 command 执行、
  user fork 动态 ownership、无 thread `turn.start` route、post-RPC 协调结果、
  relation 首次发布竞态和 reasoning 对象展开仍有丢失或泄露窗口；以上项目
  加入本切片强制门禁，修复及回归测试完成前不得提交。
- 2026-07-28：R3 第四切片完成。migration barrier 先于 route/orphan 恢复，
  stable notification/request handler 先于 command 恢复安装；command ingress
  在 Router ready 前持久暂停，root/user fork/child ownership 与 post-RPC
  outcome-unknown 均在持久 route 上协调。child relation 生命周期串行化并
  保存 active turn，bound projection 失败回落 durable orphan；reasoning
  journal 按 stable-v2 白名单重建。CLI build/typecheck、`100` 个测试文件和
  `973/973` 单元测试全部通过。
- 2026-07-28：R3 第四切片最终审查新增三项门禁：拒绝 command/payload
  thread target 冲突；补齐“provider 先运行、Happy Server 后连通”的 root
  snapshot 迁移；route 恢复时显式清除空 active turn。三项修复及回归测试
  完成前撤回 R3-4 提交就绪结论。
- 2026-07-28：R3 第四切片提交前最终控制流复核确认 Node readline 会在
  同一 stdout chunk 内同步派发响应后的 provider request，而命令续体稍后
  才登记 root/review route；新增有界 route-registration 协调门禁。同时
  补充无任何 route 时 root binding 仍需接收 connection/flush 的门禁。
- 2026-07-28：差异安全审查确认 Sync v4 入站解密执行 canonical schema
  校验，但 CLI 出站加密此前只依赖静态类型；新增加密前 schema 门禁，防止
  运行时越界 provider entity 被 Server 持久化后在 App 侧阻塞接收 cursor。
- 2026-07-28：R3-4 崩溃边界复核发现 parent `spawnAgent` 只登记 lineage、
  child 首个通知尚未到达时，持久 route 没有状态，重启恢复会跳过仍运行的
  child；新增初始 `starting` route 与无 orphan 主动恢复门禁。
- 2026-07-28：R3-4 每线程时序复核发现 bound notification 投影失败转为
  orphan 后，后续 live notification 仍可直接越过；新增 live/orphan 统一
  FIFO 门禁，避免 turn 与 child relation 状态倒序。
- 2026-07-28：R3-4 ownership 复核发现 child 的无 target
  `mcp.status.list` 会回退到 app-server selected thread；新增 thread-scoped
  查询必须显式命中 owned child 的门禁。
- 2026-07-28：R3-4 最终本地门禁完成。CLI build/typecheck、`101/101`
  测试文件和 `993/993` 单元测试通过；`10` 个定向文件、`127/127` 覆盖
  canonical 出站、route 注册竞态、live/orphan FIFO、无 orphan child 恢复、
  ownership、迁移、请求恢复和离线重连。
- 2026-07-28：R3-4 提交 `78d2638` 的 CLI Smoke `30354064576`、Push CI
  `30354064557` 和 PR CI `30354062407` 全部通过；四包构建、PostgreSQL
  migration、stable-v2 drift、跨组件 transport 和生产依赖审计均为绿色。
- 2026-07-28：R4 第一切片完成 App client/MMKV 恢复状态机。registry 在
  session refresh 之外自行指数退避并可由前台/重连提前唤醒；changes 在
  解密前区分 new、exact replay、superseded 并拒绝同 revision 冲突；
  snapshot 使用 shadow generation，完整验证后以一次 store transaction
  替换 projection，再提交 active generation/cursor。entity/outbox 派生
  index 改为固定分桶且可从独立 record 重建，恶意 legacy marker 不能删除
  outbox。App typecheck 通过，`77/77` 测试文件、`869/869` 单元测试通过。
- 2026-07-28：R4 第二切片完成增量 projection 反向索引。part、turn、item、
  relation、command 和 result 只重建受影响的稳定 message；同一 item 的
  request 各自使用独立 control。thread usage 优先、最新 turn usage 回退，
  v4 激活后不再读取 legacy usage。删除、跨 owner 重定位、command replacement
  恢复和 `10,001` entity 单 delta 均有回归测试，规模测试只替换目标 message
  对象。
- 2026-07-28：R4 第二切片提交 `6f39b157` 的 CLI Smoke
  `30357006804`、push CI `30357005987` 和 PR CI `30357002428`
  全部通过。R4 第三切片复核发现 provider child 仍可从 fork/duplicate
  入口进入写路径，且多 thread entity 以最新 `updatedAt` 选择会让旧 thread
  迟到更新覆盖 metadata 当前选择；新增 UI/最终执行双层 fork 门禁，以及
  metadata 驱动的 thread/runtime/usage/messages 投影隔离门禁。
- 2026-07-28：R4 第三切片本地完成。provider child 从 composer、Markdown
  option、工具审批、用户输入、MCP、goal/mode/interrupt、fork/duplicate
  到 resume/kill/archive/delete 均为 UI 与最终执行双层只读。projection
  由 metadata `codexThreadId` 选择当前 thread/runtime/usage/messages，旧
  thread 迟到 delta 保持当前 message list 引用；active turn 与重复 request
  ID 均按 owned thread 对账，runtime 缺失标记 unknown。App typecheck、
  `78/78` 测试文件、`886/886` 单测及 Web export 全部通过。
- 2026-07-28：R2 完成。CLI session 初始化和关闭使用 generation 隔离；
  journal 增加单 writer lease、durability poison、可回收字节压缩和终态
  command receipt；显式 outbound flush 固定调用时集合，后台 outbound 使用
  固定预算，inbound 固定首次 watermark。lock 文件由本进程通过 `O_EXCL`
  创建后，写入或 fsync 失败会无条件清理，避免部分 lease 永久阻塞恢复。
  CLI TypeScript 检查通过，R2 四个定向测试文件共 `62/62` 通过；本机
  Vitest global setup 的 pnpm store 检查失败仅产生日志，测试进程本身成功。
- 2026-07-28：R2 提交 `4a5b2ac9` 的 push CI `30332614672`、PR CI
  `30332612493` 和 CLI Smoke `30332614666` 全部通过。R3 源码复核确认
  migration activation、mapper published marker、late turn completion、
  forced interrupt、request delivery state 和 detached thread 分类均存在
  计划所述缺口；按新增四提交顺序整改。
- 2026-07-28：R3 第一切片完成。mapper 仅在 mutation 持久写入 outbox 后
  提交内存实体与 part marker；snapshot/live 使用 per-thread barrier 原序
  重放；migration 使用 `pending -> importing -> activating -> ready`
  协调 ready ACK 与本地状态。finalized stream 成功发布后释放正文，child
  binding 激活或恢复失败会关闭 lease/socket 并允许重新创建。CLI typecheck、
  `git diff --check` 和五个定向测试文件 `50/50` 通过；完整 CLI unit suite
  在工作区内通过 `925/933`，仅因沙箱禁止写 `~/.claude/projects` 导致
  Claude scanner 的 `8` 项 `EPERM`，授权该测试目录后单独重跑 `8/8`
  通过。
