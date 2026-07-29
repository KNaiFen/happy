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
10. Sync v4 诊断默认开启，但只允许写入 Wire 定义的字段白名单。任何
    prompt、raw reasoning、工具参数、工具输出、ciphertext、token、密钥、
    文件内容、外部错误对象和真实 provider ID 都不得进入诊断记录。
11. 重构初期的诊断必须能在不读取业务明文的前提下复原故障边界。每个进程
    至少留下版本、协议、v4 开关、传输安全模式和连接 epoch 的启动指纹；
    每个终态留下稳定事件分类及 dropped、suppressed、invalid、write
    failure、pending 等有界计数。不得使用自由文本错误消息代替这些字段。

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
- [x] `turn/completed` 只有在 payload 同时包含可验证的 thread、turn 和
      terminal status 时才能结算 completion；缺字段、类型错误或未知状态的
      terminal notification 必须丢弃并写 payload-free protocol diagnostic，
      不得产生 legacy `task_complete` 或清除 thinking/keepAlive。
- [x] file-change approval request 与对应 item 可任意乱序到达。request
      早于 item、晚于 item 及晚于 item/completed 时，canonical request/item
      必须最终收敛到同一 thread 的 patch；临时 legacy metadata 不得误复用
      其他 thread、turn 或 item 的 patch。
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
- [x] terminal child 必须关闭不再需要的 Sync client/socket、mapper 和
      runtime listener；持久 route、relation 与 lineage 继续保留用于历史
      导航、迟到 notification 和进程恢复。资源释放必须幂等，迟到通知需要
      时可按持久 route 有界重建 binding，不能让历史 child 数量等比例占用
      长连接资源。
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

R5 真实 HTTP 场景复核发现 CLI/App snapshot client 硬编码请求 500 条，
但 Wire 与 Server 的权威上限为 100，真实路由会在 handler 前返回 400。
CLI/App 必须直接引用 `MAX_SYNC_V4_SNAPSHOT_ENTITIES_PER_PAGE`，transport
测试必须断言真实请求不超过 Wire 上限；fake transport 不得再掩盖该错误。

### R5 HTTP 平台支持

- [x] 每安装实例的 server-config 模型增加显式
      `allowInsecureHttp`，默认关闭，首次启用显示风险确认；该值不得进入账户
      Settings 同步，避免一台设备的确认静默放宽其他设备。
- [x] CLI 对 HTTP 自定义 relay 输出一次清晰的安全降级提示。
- [x] Android production 通过 config plugin 把 cleartext 写入生成 manifest，
      并在 prebuild 后与最终 APK 两层 CI introspection 中断言。
- [x] iOS production 允许已确认的 HTTP relay，并在 CI 检查 ATS 结果。
- [x] Tauri REST 使用受控 native transport；Rust 必须同时校验请求 URL 与
      已提交 relay base 同源、HTTP 已显式授权，并拒绝跨源重定向。不得把
      任意 URL native fetch 暴露给 WebView。
- [x] Tauri capability 不再无条件放行 `http://**`，CSP 不保持全关闭状态。
- [x] `happy server` 分离 bind URL、local URL 和 advertised `--public-url`。
- [x] bundled Web App 默认使用 `window.location.origin`。
- [x] Web 设置拒绝非 localhost HTTP，并解释浏览器限制。
- [x] Socket.IO 与轮询分别验证；invalidation 丢失时仍能拉取恢复。

R5 transport 与 URL 边界：

- App 保存自定义 server URL 时先规范化并拒绝 credentials、fragment 和非
  HTTP(S) scheme。HTTP 在 Android、iOS、Tauri 上要求本机
  `allowInsecureHttp=true`；普通 Web 只允许 loopback HTTP。
- 旧版本已经保存 HTTP relay、但尚无授权标记时，App 启动必须进入可操作的
  离线 UI，而不是卡在 splash；用户可进入 server 设置完成首次风险确认，
  随后按既有服务器切换流程重新登录。
- URL 设置页的确认不是安全边界。REST transport、Tauri Rust command 和
  Socket 初始化必须再次执行相同策略，防止损坏或手工修改的本地存储绕过。
- Tauri 自定义 native transport 仅接管当前 Happy relay 同 origin 的 REST
  请求；HTTPS 第三方请求继续使用 Web transport。native response 必须有
  明确大小上限，避免不可信 HTTP peer 造成无界 IPC 内存占用。
- Tauri authenticated REST command 不得从 WebView 的单次请求读取
  `baseUrl` 或 `allowInsecureHttp`。Rust state 持有最近一次提交的 relay
  policy，普通请求只携带目标 URL、method、headers 和 body，并再次按该
  policy 校验 scheme 与 origin。设置页保存前的候选 relay 只允许通过独立、
  无认证、固定 `GET /health` 的有界 native probe 验证，不得复用可转发
  bearer token/body 的通用请求命令。
- [x] Tauri relay policy 只允许在 App 启动或设置提交时更新；普通认证请求
  不得隐式重写 policy。无效配置、撤销 HTTP 授权和 reset 必须 fail-closed
  清空 Rust 中的旧 policy。所有显式 policy 提交必须经过同一个进程内串行
  边界，并在取得锁后重新读取当前配置，保证旧设置提交晚到时不能覆盖新
  policy；普通业务请求不参与该锁，也不得修改 policy。
- [x] Tauri native transport 的二进制 body 通过有界 Base64 字符串跨 IPC，
  不使用逐字节 `number[]`/JSON 数组；Rust 在解码前后都执行大小门禁，响应
  在编码前执行流式大小门禁，避免 4--32 MiB payload 在 IPC 中数倍膨胀。
- relay 返回的附件上传/下载 URL 在 App 与 CLI 中都只有与 Happy Server
  精确同 origin 时才能携带 bearer token；禁止用字符串前缀判断，避免
  lookalike hostname 获得认证头。外部 presigned URL 不带 Happy token。
- Tauri production CSP 至少限制 default/script/style/connect 源；HTTP REST
  通过 native invoke，不通过通配 `connect-src http:`。开发配置可单独放宽
  localhost dev server，不改变 production policy。
- Tauri 的 Socket.IO 仍运行在 WKWebView。macOS bundle 必须通过专用
  `Info.plist` 允许已由 App policy 确认的 WebContent `ws://` 与本地网络，
  同时保持 CSP 不允许通配 browser `http:` fetch；不得假设 reqwest REST
  放行会自动解除 WebSocket 的 ATS 限制。
- `happy server --host` 只决定监听地址；local URL 是本机可访问地址；
  `--public-url` 是其他 CLI/App 使用且写入 `PUBLIC_URL` 的 advertised URL。
  bundled Web App 不信任 injected advertised URL，而以自身
  `window.location.origin` 连接同源 relay。
- [x] `happy server --host` 严格校验成对 IPv6 方括号、IP 和 DNS label；
  不得静默修复不成对括号、首尾连字符或超长 label 后继续监听。校验后的
  normalized bind host 必须同时用于展示 URL 和实际传给 Server 的 `HOST`，
  避免括号 IPv6、大小写或首尾空白出现“展示正确但监听失败”。
- Android 门禁同时检查生成配置和最终 manifest 的 cleartext 标志；iOS
  门禁检查 production Expo config 的 ATS 字段；Tauri 门禁静态检查 CSP、
  capability 和 native origin 校验代码。以上平台放行只解除操作系统限制，
  不能替代 App 的显式授权。
- RootLayout 只允许把 relay policy 或 `syncRestore` 连接失败降级为离线 UI；
  font、crypto 和 credential hydrate 等更早的初始化失败不得被误判为 relay
  离线并继续进入未初始化界面。
- `syncRestore` 的离线降级必须由显式 `ServerUrlPolicyError` 触发；无效密钥、
  解密失败、本地持久化损坏和其他未知异常不得被宽泛 `catch` 吞掉。
- Tauri 自定义 command 的边界以 bundled WebView 代码可信为前提；WebView
  本身持有 bearer token 和端到端密钥，因此本轮防护目标是阻止实现缺陷、
  损坏配置和不可信 relay 造成跨 origin 转发或无界资源消耗，不宣称在
  WebView 已被攻陷后继续保护凭据。改变该边界需要把认证和加密整体迁入
  native 层，超出本轮 Codex transport 整改范围。
- R5 实际链路门禁启动临时 PGlite Happy Server，通过 `/v1/auth` 取得真实
  bearer token，并创建真实 session。Socket.IO 必须强制 websocket transport
  且收到一次 `sync-v4-invalidate`；随后主动断开该 socket，继续由 fake
  stable-v2 Codex 经 CLI durable client 写入 relay，App 侧只依靠定时
  `changes` 拉取恢复并形成最终 projection。
- macOS Tauri job 使用锁定依赖执行 `cargo fmt --check`、
  `cargo check --locked` 和 Rust library tests。该编译只在 GitHub macOS
  runner 执行，不在本机生成 `src-tauri/target`。

### R6 测试与 CI

- [x] Wire：schema 正反例、响应字节预算、INT32、分页不变量、SemVer。
- [x] Server：真实 PostgreSQL migration、并发 POST、prune/410、receipt。
- [x] CLI：journal 每个崩溃边界、单 writer、持续流量和 unknown RPC。
- [x] Gateway：snapshot/live、orphan FIFO、多 thread、fork/review/child、
      request 恢复和 stable variant 覆盖。
- [x] App：启动重试、stale ciphertext、shadow snapshot、坏索引、child
      双层只读、多审批和 usage 恢复。
- [x] 业务链路模拟：fake Codex app-server -> CLI -> relay -> App projection。
- [x] Codex 版本探测使用有界直接进程调用；真实 provider 在 5 秒内无法返回
      版本时启动失败，显式 fake app-server 测试路径不依赖本机 Codex。
- [x] 同一个 Codex client 复用已验证的 provider 版本；启动、能力声明和
      steer 不得重复启动同步 `codex --version` 子进程。
- [x] Chaos：100,000 mutation 的重复、延迟、断网、丢 invalidation，最终
      snapshot 完全一致。
- [x] 性能：10,000 entity + 5 Hz delta，健康本地链路 p95 < 750 ms。
- [x] 长 turn：虚拟时钟 2 小时不假结束。
- [x] 长 turn：真实 wall-clock 超过 10 分钟，仅在权威完成通知后结束。
- [x] 生命周期乱序：迟到的 `thread/started` 元数据不得用旧 `idle` 状态
      结束已经由 `turn/started` 登记的 active turn；真实子进程场景必须
      覆盖该顺序，CLI completion registry 与 Sync v4 canonical runtime
      projection 都必须保持 active。
- [x] `thread/started` 只补充元数据：已有权威 thread status 时不得被其中
      的旧状态覆盖；`turn/start` 明确失败后不得残留由 pending start 合成
      的 active 状态。registry 与 mapper 都必须覆盖 idle/systemError 回归。
- [x] GitHub CI 覆盖 Wire、Server、CLI、App 的 typecheck、unit test 和 build。
- [x] GitHub CI 覆盖 Agent 的 typecheck、unit test 和 build，并将 Codex
      provider、CLI transport、relay 路由和 App projection 的故障场景作为
      独立 required gate。
- [x] GitHub CI 覆盖 Prisma migration drift、协议生成 drift 和业务链路模拟。
- [x] Android release workflow 保留现有签名、ABI、OTA、SDK 和 16 KiB 检查。
- [x] CLI release workflow 产出单一可安装 tgz 并验证内置工具归档。

R6 场景与性能口径：

- `codex_transport_scenarios` 安装并校验 `codex-cli 0.145.0`，实际业务链路
  使用 `experimentalApi=false`；测试不得以 legacy notification 形成
  canonical entity。strict stable-v2 fake 必须主动拒绝
  `experimentalApi=true`，不能只验证字段类型。
- 真实 Codex 启动的 `codex --version` 在 Unix 必须使用无 shell 的直接
  进程，在 Windows 只为 npm `.cmd` shim 使用固定命令 shell；两者均设置
  5 秒超时、强制终止和小输出上限，探测挂起不得永久冻结 CLI。测试专用
  `HAPPY_CODEX_APP_SERVER_PATH` 不执行与实际 fake transport 无关的本机
  Codex 探测，但真实 app-server 路径继续强制最低 `0.145.0`。
- CI 安装固定 Codex 后的版本校验和业务脚本二次校验同样必须有界，provider
  二进制挂起只能快速失败当前门禁，不能耗尽整个 job timeout。
- stable-v2 协议生成脚本自身的版本探测和 `app-server generate-ts` 也必须
  设置硬超时；不能只依赖 workflow 外层预检或 job 级超时。
- 10,000 entity 性能场景先在 App projection 中建立至少 5,000 item 与
  5,000 part，再以 fake provider 每 200 ms 发送一个 agent delta。延迟从
  CLI 收到 stable notification 计时，到 App projection 可见对应文本为止；
  至少采集 20 个样本并要求 p95 小于 750 ms。
- invalidation 丢失通过真实 Socket.IO 断开制造；测试不得直接调用 App/CLI
  invalidate 来伪造恢复，最终 cursor、文本和 idle runtime 必须来自 REST
  polling。
- 两小时长 turn 使用虚拟时钟单测，期间 completion promise 必须保持
  pending；超过十分钟的真实 wall-clock turn 由独立云端 job 驱动真实 fake
  app-server 子进程，并只在官方 `turn/completed` 后结束。
- 长 turn 门禁的 settled 观察不得通过未消费的 `Promise.finally()` 分支制造
  unhandled rejection；失败必须由被等待的原始 turn promise 统一报告。
- 长 turn 在十分钟检查点前提前 resolve/reject 时必须立即失败并报告实际
  elapsed，不能继续占用 runner 到检查点后才暴露状态机错误。
- [x] PR duplicate long-turn job 因 registry 下载停滞而未进入有效测试时，
      允许在同一提交上重跑一次；若连续复现，必须为依赖安装增加独立的
      有界超时与重试预算，并相应扩大 job 总预算，不能缩短真实十分钟门禁。
- 100,000 mutation Chaos 沿用确定性 seed，覆盖重复 POST、响应提交后断连、
  重排、cursor 提交前崩溃、丢失全部 invalidation 和 snapshot fallback；
  不再增加功能重复但规模更小的第二套实现。

### R7 可观测性与诊断

- [x] Wire 定义严格的 `SyncV4DiagnosticRecord` schema 与错误分类器。事件
      只包含枚举状态、计数、时延、seq/revision/cursor/watermark、随机
      trace ID 和散列/opaque ID；schema 必须拒绝额外字段和自由文本 payload。
- [x] Wire 诊断 schema 提供启动指纹和终态汇总所需的固定字段：v4 是否启用、
      `https/insecureHttp` 传输安全模式，以及 suppressed、invalid 和 write
      failure 计数。CLI、App、Server 不得记录 relay URL、hostname、IP、
      Authorization 或任意环境变量值来补充这些信息。
- [x] CLI 与 App 的每次 v4 HTTP 操作生成独立 128-bit trace ID，通过
      `X-Happy-Sync-Trace` 发送；Server 回显并写入同一事件。CORS 只额外
      放行、暴露该固定 header，不接受客户端提供的任意日志对象。
- [x] CLI 默认在 `~/.happy/logs` 写入权限为 `0600` 的结构化 Sync v4
      JSONL。单文件、分段数和保留期均有硬上限；多 session/process 文件
      互不争用；写入失败只计数并在 flush/close 暴露，不递归记录原始错误。
- [x] CLI 诊断 JSONL 的异步待写队列同样必须有字节硬上限；磁盘变慢时
      保留最新记录、淘汰最旧待写记录并累计 `droppedRecords`，不得让长 turn
      因诊断积压产生无界内存。关闭时普通脱敏日志必须输出最终计数摘要。
- [x] Codex JSON-RPC shape trace 在 v4 会话默认开启，只记录方向、时序、
      方法、payload shape 和散列 ID。内存 pending/request 与 snapshot
      均有界，磁盘使用同一轮转/保留策略；raw payload 永不保留。
- [x] 协议 trace 只保留 stable-v2 已知 method；未知 method 写固定前缀加
      HMAC 摘要。RPC request/response 关联键使用固定长度摘要，不得把原始、
      超长或恶意 method/RPC ID 作为内存 Map key 或落盘字段。
- [x] 协议 trace 的 thread/turn/item/request 等 provider ID 使用与 CLI
      结构化诊断相同的固定长度散列，使两类日志可直接关联；RPC ID 和未知
      method 仍使用进程随机 HMAC，避免把外部自由文本变成稳定字典。
- [x] App 使用独立 MMKV 环形存储持久化最近的 Sync v4 诊断。逻辑容量 N
      使用 N+1 个物理槽，先写未占用物理槽、再以单一 head 作为提交点，
      满环时 head 写失败也不得覆盖旧的已提交窗口；损坏槽位可跳过。开发
      日志页可查看、复制和清除，普通 console 日志不得混入该持久诊断。
- [x] App 复制诊断时输出可直接保存的按时间排序 JSONL，并包含最近一次启动
      指纹与本地 sink 计数；清除操作只删除 Sync v4 诊断。CLI 日志文件名、
      当前段和终态统计必须能从普通脱敏日志定位，方便把三端相同 trace ID
      交给维护者检索，不新增上传明文或自动上报能力。
- [x] Server 为 mutation、changes、snapshot、invalidation、journal prune
      写结构化事件，并增加 operation/outcome/duration/page-size/pruned
      指标。标签只能来自固定枚举和有界 client type，不得使用 session、
      trace、entity 或 provider ID 作为 Prometheus 标签。
- [x] journal prune 是 mutation commit 之后的 best-effort 维护步骤。清理
      失败必须记录受控错误分类和指标，但不得把已经提交成功的 mutation
      POST 改写成 500；客户端仍应收到原 ACK，后续清理周期再重试。
- [x] CLI 记录 durable outbox/inbound depth 与 age、ACK 分类、cursor、
      snapshot fallback、command/request 恢复和 journal poison/compact；
      Gateway 记录连接 epoch、RPC lifecycle/outcome unknown、thread/turn
      状态、orphan replay、relation/child、migration 和 stream flush。
- [x] CLI Gateway、App registry/client 和 Server capabilities 在各自第一次
      v4 操作前写启动指纹；退出、禁用、协商失败和正常关闭都写终态汇总。
      汇总至少覆盖诊断 sink 的 dropped/suppressed/invalid/write failure、
      protocol pending 与当前 outbox/inbound depth。诊断 sink 自身失败时，
      相同计数必须由既有普通脱敏日志输出，不能递归写回失败 sink。
- [x] App 记录 hydrate、outbox/ACK、changes/cursor、snapshot generation、
      registry retry/sync health 和 projection batch；断连时保留最后状态，
      诊断本身不得把 execution 改为 idle。
- [x] App 与 CLI 的所有 v4 HTTP 请求都必须携带独立 trace ID，包括 CLI
      在建立 session 前的 `/v4/capabilities` 协商。App 产生的 command
      entity 必须在加密和写入 outbox 前通过 Wire canonical schema，避免
      无效密文进入持久链路后卡住对端 cursor。
- [x] 高频健康路径必须采样，不能让诊断反过来淹没有效故障。每次 App v4
      HTTP 请求仍生成并发送 trace ID，Server 仍逐次记录；App 对无 change
      的成功轮询最多每 30 秒持久化一次并附带被抑制计数。含数据的响应、
      失败、snapshot、重试和状态边界立即落盘。
- [x] 单元测试对每个诊断 sink 注入包含 secret、prompt、reasoning 和工具
      payload 的恶意错误/对象，断言 schema 或 API 拒绝且序列化输出不含原文。
      轮转、保留、截断尾记录、MMKV 崩溃边界和损坏恢复必须覆盖。
- [x] 普通 CLI 文件日志同样遵守诊断隐私边界。未知 notification/request、
      stable union/variant、对象 key、permission mode、model 和 reasoning
      effort 只能记录固定分类或散列；不得以模板字符串或 logger metadata
      旁路泄露外部自由文本。
- [x] `ApiSession` 的共享 Socket.IO 路径不得把完整 update、ciphertext、
      原始 Error 或可能携带 Authorization/config 的 transport error 写入普通
      日志。只允许记录固定 update 分类、seq/版本等数字元数据和受控错误分类；
      该约束不能改变 Claude v3 的收发行为。
- [x] CLI 的 duplicate/completion/legacy projection 辅助 Set/Map 均有硬上限，
      并在 authoritative terminal item/turn 后尽早释放；单个长期连接不能
      依靠断连或 session clear 才回收。
      provider 在 terminal item 后仍可能迟到重复的旧 `started`，因此
      subagent activity 不能直接删除去重 marker；只保留每 item 最多 16 个
      固定长度 signature hash，整表最多 4,096 项，不保留 agent path/thread
      等原始 signature 字符串。
- [x] provider request 去重不得通过统一 LRU 淘汰仍在等待 App 响应的 request
      ID。活动 request 必须保留到写 response、失败或 transport epoch 结束；
      终态 marker 可以有界淘汰，但淘汰只能影响诊断去重，不能重新创建审批、
      重复写同一 JSON-RPC response 或改变 durable request broker 的对账。
- [x] capability、changes 和 snapshot 必须区分 HTTP/schema 成功与端到端
      应用成功。compatibility、连续性、解密、stage/apply、projection、
      snapshot generation 和 cursor commit 的每个失败边界分别记录
      `protocol`、`crypto`、`storage` 或 projection 诊断；不能只留下一个
      transport completed 后再由外层记录含糊的 `unknown`。
- [x] JSONL 内容 append 成功后必须立即推进字节账本；之后 chmod 等维护失败
      可以由 flush/close 暴露，但不得让后续轮转使用陈旧文件大小。测试必须
      注入“append 成功、chmod 失败”边界并验证容量仍有界。
- [x] 真实 Codex -> CLI -> HTTP relay -> App 场景必须断言 trace ID 横跨
      三端，并覆盖断连、丢 invalidation、snapshot fallback、重启恢复、
      审批和 provider child。验收同时检查日志有界、事件顺序和 payload-free。
- [x] 故障场景断言不能只检查“出现 error”。每个注入点必须能仅凭
      `event/phase/errorKind/traceId` 和数值状态定位到 transport、协议校验、
      crypto、storage、projection 或 provider RPC 中的唯一失败层；启动指纹
      与终态汇总必须让重启前后的连接 epoch 可区分。
- [x] `suppressed` 只表示健康高频事件被采样，`dropped` 只表示诊断 sink
      因容量或背压真正丢失记录；两者不得复用字段或合并计数。projection
      失败使用独立 `projection` error kind，不能伪装成 storage failure。
- [x] 真实 HTTP 场景的 App 端优先使用生产 `AppSyncV4Client`、生产 transport
      与 coordinator；若 Node 运行时依赖使完整实例不可用，场景适配层必须
      复用同一生产 transport/coordinator，并以等价性测试证明请求、snapshot
      提交、cursor、projection 和 diagnostics 边界没有另写一套状态机。
- [x] 诊断实现必须 fail-open：错误分类器不得因恶意 getter/Proxy 抛错，
      CLI/App/Gateway/Mapper/Registry 的 sink 抛错不得改变业务控制流，
      App listener 抛错不得阻断其他 listener 或把已提交记录误计为写失败。
- [x] Server 的错误分类器必须对 `statusCode`、`code`、`name` 等属性执行
      防御性读取；Proxy 或 hostile getter 抛错时返回固定 `unknown` 分类，
      `onError`/`onResponse` 仍各自最多记录一次 terminal outcome。
- [x] App 诊断环只允许在实例恢复时扫描 MMKV 槽位；常态追加、计数和 stats
      必须为 O(1)。开发日志页对高频变更做有界合并刷新并清理滚动 timer，
      打开诊断页不能把 5 Hz 流放大为反复全环解析和整页重渲染。
- [x] Server 必须覆盖 handler 前的认证、版本门禁、params/query/body schema
      与 bodyLimit 失败；每个请求的主 operation 只记录一次 terminal outcome
      和一次指标，不能因 onError/onResponse 与 handler catch 重复计数。
- [x] trace ID 在 client coordinator 与实际 HTTP transport 两层校验。App
      使用 `crypto.getRandomValues` 生成完整 16 字节随机 ID；CLI capability
      协商无论成功、禁用或失败都留下本地 payload-free 记录并安全 flush。
- [x] `BoundedJsonlWriter` 在 `maxSegments=1` 时轮转也必须截断旧 active
      文件；协议 trace 暴露 dropped/write failure 统计，场景只在 close
      完成后读取最终统计并断言健康链路零丢诊断。
- [x] shutdown cleanup 采用 best-effort 分段收敛。provider disconnect、
      Router/child close、session close、协议 trace close 任一失败都必须
      记录受控分类并继续关闭其余资源；结构化诊断 close 与普通日志终态摘要
      不得因更早的 cleanup rejection 被跳过。
- [x] HTTP 场景的 shadow snapshot 必须与生产 App 使用相同提交顺序：
      完整投影替换先于 active generation/cursor 切换；测试实现不得掩盖
      “cursor 已前进但 UI 仍是旧 generation”的崩溃窗口。

R7 诊断事件的最小关联关系：

```txt
App/CLI local operation
│
├─ sessionHash       同一加密 session 的本地 opaque 关联
├─ thread/turn/...   只使用散列 ID
└─ traceId           每个 HTTP 请求随机生成
                     │
                     └─ Server request/result/invalidation
```

保留和资源上限：

- CLI 结构化诊断与协议 shape trace 单段最多 8 MiB，每个文件最多 4 段，
  启动时清理超过 7 天且当前未更新的旧诊断文件；
- CLI 协议 trace 内存 snapshot 最多 4,096 条，pending RPC 映射最多
  4,096 条；
- CLI unknown method/variant 聚合和 legacy duplicate/completion 辅助状态
  使用显式 LRU/FIFO 上限；淘汰只影响诊断去重或 legacy UI 去重，不得改变
  stable-v2 canonical entity、request 对账或权威 turn 状态；
- App 持久环最多 2,000 条，每条必须先通过 Wire schema，单条序列化上限
  2 KiB；
- Server 不持久化客户端诊断 payload，仅写自己的白名单事件；生产日志保留
  继续由部署平台控制。

跨版本写入隔离门禁：

- Codex session 在 canonical v4 ready 后不得再调用 v3
  `sendSessionEvent`/`sendSessionProtocolMessage` 写消息或状态；
- presence、push notification 和 Claude v3 路径保持原行为；
- 测试必须从 `runCodex` 实际事件链触发，而不是只断言局部 guard 返回值。

## 发布顺序

1. 修复代码并保持 v4 Server flag 关闭。
2. 推进受影响包 patch 版本；本轮最低目标：
   CLI `1.4.5`、App `1.11.11`、Server `1.1.14`、Wire `0.1.3`。App
   `1.11.5` 已进入首轮云端 CI；后续 Tauri 格式、lockfile 闭包与可诊断
   lock drift 门禁及权威 feature-resolution lock 修复按仓库规则各自使用
   新 patch。
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
- CLI/App/Server 可用 trace ID、session opaque hash 和状态事件复原一次
  Sync v4 故障链；日志跨重启保留且在声明上限内轮转。
- 诊断隐私测试证明 prompt、raw reasoning、工具参数/输出、ciphertext、
  token、密钥、文件内容、外部错误对象和真实 provider ID 不会落盘。
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
- 2026-07-29：R7 差异审查发现协议 trace 仍保存未知 method 原文并以原始
  RPC ID 作为 Map key，普通 CLI 日志仍有动态 method/object key/model/
  effort 输出，部分 legacy 去重集合只在断连时清空，且 JSONL 在 append
  成功、chmod 失败时字节账本滞后。新增已知 method 白名单、未知值 HMAC、
  固定长度关联键、普通日志同等脱敏、辅助状态硬上限及写后故障测试门禁。
- 2026-07-29：R7 定向测试确认 terminal subagent activity 后仍会迟到旧
  `started`；终态直接删除 marker 会重复投影。改为有界 signature hash
  去重，保留乱序语义但不保留 agent path/thread 原文。
- 2026-07-29：R7 业务场景与静态复核发现磁盘轮转有界但待写 Promise 链
  无界、协议 trace 的 provider ID 无法与结构化诊断直接关联、CLI 首次
  capabilities 请求没有客户端 trace，且 App 出站 entity 缺少 CLI 已有的
  canonical schema 门禁。以上四项加入提交前阻断条件。
- 2026-07-29：R7 最终性能与失败路径复核发现 App 诊断环每次追加都会扫描
  并解析全部 MMKV 槽位，开发日志页还会按每条事件重建整环；Server 的认证、
  版本和 schema 等 handler 前失败没有结构化结果；诊断 sink/listener 与
  恶意错误 getter 仍可能反向打断业务；单段 JSONL 轮转和场景 snapshot
  提交顺序也存在边界缺口。以上项目加入发布阻断条件并要求回归测试。
- 2026-07-29：R7 普通日志与长连接状态复核发现共享 `ApiSession` 仍记录完整
  socket update/原始 transport Error，且 provider request 统一 LRU 会淘汰
  尚未结算的审批 ID；App/CLI 在 HTTP 成功后的解密、持久化、投影和 cursor
  失败也缺少精确阶段诊断。新增共享日志脱敏、活动 request 不淘汰及端到端
  分阶段诊断门禁。
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
- 2026-07-28：R5 实施前平台复核确认账户 Settings 不适合承载
  `allowInsecureHttp`，否则会跨设备传播安全降级；改为每安装实例独立
  server-config 状态，并要求 transport 再校验。Tauri 动态 HTTP relay
  改用同 origin 受控 native command，禁止恢复 `http://**` capability；
  `happy server` 明确拆分 bind、local 与 advertised URL。
- 2026-07-28：R5 首次真实 HTTP 链路执行已通过认证、WebSocket、CLI 写入、
  丢 invalidation 后轮询和 10k/5 Hz projection，随后在 snapshot 暴露
  CLI/App 请求 500、Wire/Server 只允许 100 的分页契约错误；该问题升级为
  R5 阻断项，修复并通过真实 snapshot 前不得提交。
- 2026-07-28：R5 提交前安全复核发现 Tauri `relay_http_request` 同时接受
  WebView 提供的 base URL 与 HTTP 授权位，未满足“已提交 relay policy”
  边界；改为 Rust state policy + authenticated request 与无认证 health
  probe 分离。R6 同时要求 strict fake 拒绝 experimental API、业务脚本从
  package 读取 App 版本，并让任意 workflow 改动触发完整 CI。
- 2026-07-28：R5 Tauri 可用性复核确认 reqwest 只覆盖 REST，HTTP relay 的
  Socket.IO 仍需 WKWebView 建立 `ws://`；新增 macOS WebContent ATS 配置
  与 CI 静态门禁，避免 REST 正常但实时 invalidation 永久离线。
- 2026-07-28：R5 提交前恢复路径复核发现 RootLayout 宽泛捕获全部
  `syncRestore` 异常，会把无效密钥、解密或本地持久化错误误报为 relay
  离线；计划收紧为只对显式 `ServerUrlPolicyError` 提供可进入设置页的
  降级路径。
- 2026-07-28：R5/R6 本地发布门禁完成：CLI `102/102` 文件、
  `1007/1007` 单测和 version-stamped build 通过；App `80/80` 文件、
  `909/909` 单测、typecheck 与 production Web export 通过；Codex
  `0.145.0` stable-v2 生成零漂移，HTTP 平台静态门禁通过，真实 HTTP
  业务链路 p95 `239.4 ms`，production audit 为 `0 critical`。真实十分钟
  turn 与 Tauri `cargo fmt/check/test --locked` 保留给云端 required jobs。
- 2026-07-28：R5 最终依赖复核确认受控 Rust transport 已完全替代
  `@tauri-apps/plugin-http`，App 与 Tauri 均无剩余引用；从 App manifest
  和 pnpm lockfile 删除该死依赖，避免继续安装未授权的通用 HTTP 插件。
- 2026-07-28：R6 真实链路复跑暴露 `CodexAppServerClient.connect()` 的
  `codex --version` 无超时，provider 二进制挂起会永久冻结场景与 CLI；
  版本探测改为 5 秒有界 `execFileSync`，并让显式 fake app-server 测试路径
  不依赖本机 Codex，同时保留真实启动的 `0.145.0` 门禁。
- 2026-07-28：版本探测差异复核补回 Windows npm `.cmd` shim 兼容，并为
  GitHub 固定版本预检与业务脚本二次校验增加硬超时；Unix 真实启动仍使用
  无 shell 直接进程。
- 2026-07-28：HTTP 安全差异复核发现 App 与 CLI 的附件本地存储路径均用
  字符串前缀判断 Happy Server，lookalike hostname 可诱导跨 origin 请求
  附加 bearer token；两端改为 URL origin 精确比较，并增加上传、下载
  回归测试。
- 2026-07-28：R5 最终 native transport 审查发现普通请求仍会先调用
  `relay_http_set_policy`，配置切换并发时可互相覆盖，撤销授权后还可能保留
  旧 Rust policy；同时逐字节数组 IPC 会让 MiB 级 payload 数倍膨胀。新增
  “启动/设置提交才更新、无效配置清空、普通请求只读”和有界 Base64 IPC
  阻断项，并明确 bundled WebView 是既有可信边界。
- 2026-07-28：R6 最终性能与诊断复核发现同一 client 会重复同步执行
  `codex --version`，长 turn settled 观察还会创建未消费的 rejected
  `finally` promise；新增版本缓存和无旁路拒绝门禁。
- 2026-07-28：R5 CLI URL 复核发现 bind host 会独立剥离首尾 IPv6 方括号，
  从而把不成对输入静默改写为合法地址，且 DNS label 首尾连字符未拒绝；
  新增严格 host 语法与回归测试门禁。
- 2026-07-28：R6 provider 进程搜索确认 capability discovery 已改用统一
  version reader，但 stable-v2 生成脚本的版本读取和 schema 生成仍可无界
  挂起；新增 10 秒版本探测、64 KiB 输出和 2 分钟生成硬超时。
- 2026-07-28：R5 最终调用链复核发现 Tauri 显式 policy commit 尚未经过
  同一串行边界，设置操作重叠时仍存在旧提交晚到窗口；同时 CLI 只把
  normalized bind host 用于展示 URL，Server `HOST` 仍收到原始输入。两项
  加入提交前阻断门禁并要求并发/IPv6 回归测试。
- 2026-07-28：R5/R6 最终本地复核通过。App `80/80` 文件、
  `911/911` 单测；CLI 合计 `1011/1011` 单测，其中既有 Claude scanner
  `8/8` 在授权其测试目录后通过；两端 typecheck、CLI build、workflow YAML、
  HTTP 平台门禁、frozen lockfile、production `0 critical` audit 和
  `git diff --check` 通过。真实 HTTP 业务链路再次通过，p95 `243.3 ms`。
- 2026-07-28：R5 最终调用链阻断项完成。App policy commit 使用统一
  `AsyncLock`，在取得锁后读取当前配置；并发回归测试证明第二次提交不会
  越过仍在进行的第一次提交。CLI 将 normalized bind host 同时用于 URL
  展示与 Server `HOST`，方括号 IPv6 回归通过。最新本地门禁为 Wire
  `38/38`、Agent `227/227`、Server `95/95`、App `81/81` 文件及
  `915/915`、CLI `1019/1019`；workflow YAML、frozen lockfile、
  production `0 critical` audit 和 `git diff --check` 通过。真实 HTTP
  业务链路 p95 `322.1 ms`。本机未安装 Bun/Rust，Server runtime build、
  Tauri fmt/check/test 与真实十分钟 turn 继续由 GitHub required jobs 验证。
- 2026-07-28：提交 `b9b36f2` 后，push CI `30379938973` 与 PR CI
  `30379934547` 均已启动。PR CI 的 Tauri job `90344992161` 在编译前由
  `cargo fmt --check` 拒绝 `build.rs`、`lib.rs` 和 `main.rs` 的既有两空格
  Rust 风格；云端日志给出了确定性 rustfmt diff。修复限定为应用该 diff，
  App 推进到 `1.11.6`，再提交并重跑全部 required jobs；本地仍不安装
  Rust/Tauri 工具链。
- 2026-07-28：提交 `bdc50de` 的 push CI `30380523592` 已通过 rustfmt，
  随后 `cargo check --locked` 在编译前拒绝会被更新的 `Cargo.lock`。
  从 lock 的 `app` 根节点解析全部 561 个 package 与无歧义依赖边后，确认
  唯一不可达集合为 `tauri-plugin-http@2.5.2`、
  `tauri-plugin-fs@2.4.2` 和 `data-url@0.3.2`。修复限定为删除这三个
  package block，App 推进到 `1.11.7`，再由云端 locked check 验证。
- 2026-07-28：提交 `6df4adf` 的 push CI `30380862539` 仍在编译前仅报告
  lockfile 需要更新，证明 package 可达图不足以重建 Cargo feature
  resolution。Tauri job 改为先运行 `cargo metadata` 并用
  `git diff --exit-code` 输出权威 lock drift，再执行
  `cargo fmt/check/test --locked`；该诊断门禁永久保留，App 推进到
  `1.11.8`。
- 2026-07-28：提交 `762e505` 的 push CI `30381234770` 由 Tauri job
  `90349414969` 输出完整 Cargo metadata drift。直接 `reqwest` 的解析结果
  删除 cookie store、QUIC/HTTP3 和不再可达的 rustls 辅助闭包，增加系统
  TLS 所需的 native-tls/OpenSSL/Security Framework/Schannel 条目；这与
  当前仅使用普通 HTTP 方法、显式 header/body 且禁用重定向的 transport
  能力边界一致。修复限定为原样应用云端 diff，App 推进到 `1.11.9`，再跑
  `cargo check/test --locked`。
- 2026-07-28：提交 `7a74d71` 的 push CI `30381641311` 与 PR CI
  `30381644859` 除真实十分钟 turn 外全部通过，CLI Smoke
  `30381645230` 在 Linux/Windows 与 Node 20/24 全绿。两个长 turn 均在
  约 `600257 ms` 检查点报告提前 settled；trace 证明 fake provider 的
  `turn/completed` 配置在 `601500 ms`，根因锁定为 `thread/start` 响应后
  迟到的 `thread/started(idle)` 可越过新 `turn/started` 并错误结算 active
  turn。差异审查进一步确认同一通知还会把 Sync v4 canonical runtime
  投影为 idle，即使 completion registry 已保持 pending。修复限定为区分
  元数据通知与权威状态边界、让 mapper 以既有 live active turn 抵御迟到
  idle metadata、补充 registry/mapper/真实子进程乱序回归，并让长 turn
  提前结算时 fail-fast；CLI 推进到 `1.4.4` 后重新跑全部云端门禁。
- 2026-07-28：迟到 `thread/started` 修复通过 CLI typecheck、bundle、
  registry/client/mapper 定向 `80/80`、事件驱动真实 fake app-server 乱序
  场景及 Codex -> CLI -> HTTP relay -> App projection 业务链路，健康流式
  p95 `241.2 ms`。完整 CLI unit suite 共 `1021/1021`：工作区沙箱内
  `1013` 项通过，唯一受限的 Claude scanner `8/8` 在授权写入其测试临时
  目录后单独通过。bundle 版本确认为 `1.4.4`；下一门禁为重新提交并等待
  云端真实十分钟 turn、全矩阵 CI 与 CLI Smoke。
- 2026-07-28：提交前差异审查发现第一版乱序修复仍把 pending start 遇到的
  `thread/started(idle)` 写成 synthetic active；若 `turn/start` 随后返回
  明确错误，`failTurnStart` 只清 pending completion，runtime 会永久残留
  active。同一 metadata 也可把已知 `systemError` 降为 idle。修复边界收紧
  为：已有 registry/mapper 状态时 `thread/started` 只合并元数据，状态只由
  turn lifecycle、`thread/status/changed` 或权威 snapshot 推进。
- 2026-07-28：metadata 状态边界修复完成。registry、mapper 与 app-server
  client 定向 `83/83`、CLI typecheck、真实 fake provider 乱序门禁及
  Codex -> CLI -> HTTP relay -> App projection 通过；10k+ entity、断开
  invalidation 后轮询收敛场景的健康流式 p95 为 `239.8 ms`。
- 2026-07-28：提交 `58fd524` 的 push CI `30385923082` 全绿，包含真实
  十分钟 turn 与 required gate；CLI Smoke `30385927463` 的 Linux/Windows、
  Node 20/24 全绿。PR CI `30385927478` 的 duplicate long-turn job 并非
  业务失败：`pnpm install` 从 `18:08:20` 到 `18:27:45` 停滞 `19m44s`，
  后续 Codex 安装约 3 分钟，真实测试在 `18:31:02` 才启动并于 47 秒后被
  25 分钟 job timeout 取消。先在相同提交上重跑 failed jobs；若安装停滞
  连续复现，再增加安装级有界重试与总 job 预算，不降低十分钟验收口径。
- 2026-07-28：PR CI `30385927478` attempt 2 的 failed-jobs rerun 正常完成
  依赖安装并通过真实十分钟 turn（job `90372107716`，总耗时 `11m0s`）与
  required gate。最终云端结果：push CI `30385923082` 全绿、PR CI
  `30385927478` 全绿、CLI Smoke `30385927463` 的 Linux/Windows 和
  Node 20/24 全绿；单次 registry 停滞未连续复现，不修改十分钟门禁。
- 2026-07-29：重构初期故障诊断被提升为发布阻断项。现有 CLI 任意对象日志
  与 Codex trace 无界、App 日志重启丢失、Server 缺少跨端关联，不能满足
  后续排错要求；新增 R7 字段白名单、默认有界持久诊断、HTTP trace ID、
  Gateway/状态机事件、Server 指标和跨端故障日志断言。R7 完成并通过云端
  required gate 前继续保持 `HAPPY_CODEX_SYNC_V4_ENABLED` 关闭。
- 2026-07-29：R7 首轮包级失败测试确认 Wire schema 本身通过，但暴露五项
  发布阻断：CLI capability 诊断在请求完成后才打开，禁用/失败路径无本地
  trace；Server `onError` 会尝试修改原始 Error，且前置失败的单次计数尚未
  完成类型验证；CLI/App 在 HTTP 成功后、协议 ACK/游标/分页校验前存在
  “transport success”误报窗口；协议 trace 与 CLI 诊断在 close 前读取统计；
  HTTP 场景仍先提交 snapshot generation/cursor、后替换 projection。
  修复顺序锁定为先补 fail-open 生命周期和终态统计，再修协议成功边界与
  snapshot 顺序，最后通过包级测试和真实链路统一验收。
- 2026-07-29：App 诊断环 wraparound 故障注入证明“记录槽位先于
  head/count”在逻辑容量已满时仍会先覆盖旧窗口。R7 持久化协议修正为
  N+1 物理槽与单一 head 提交点；开发日志页只在 Sync v4 页签激活时扫描
  和订阅，避免 console 页签把高频流放大为全环解析。
- 2026-07-29：提交前复核发现畸形 `turn/completed` 仍可产生 legacy
  `task_complete` 并错误清除长 turn 状态；Server 错误分类器直接读取
  `statusCode`，hostile getter 可让诊断路径自身抛错。两项升级为发布阻断，
  要求 payload-free 回归测试和 fail-open hostile object 测试。
- 2026-07-29：链路覆盖复核发现 canonical v4 ready 后停止 v3 写入主要依赖
  `runCodex` 局部 guard，HTTP 业务场景 App 端仍使用自定义 client；同时
  terminal child binding 只在 Router close 时释放，file-change approval
  的 request/item 乱序尚无收敛证明。新增实际事件链隔离、生产 App client
  等价性、child 资源生命周期及审批乱序门禁。
- 2026-07-29：R7 续审发现 App 将健康采样抑制误记为 `dropped`，projection
  callback 失败被归类为 storage，且 `runCodex` 的 provider disconnect
  rejection 会跳过后续 trace/诊断关闭。三项升级为发布阻断：拆分
  suppressed/dropped、增加 projection error kind，并把 shutdown 改为
  分段 best-effort 收敛后再输出最终统计。
- 2026-07-29：R7 提交前复核确认 App 诊断环在 head 元数据损坏时仍会从
  物理槽推断最新 sequence，这会把崩溃边界上尚未提交的槽误认为已提交；
  head 必须继续作为唯一提交点，损坏时宁可丢弃诊断窗口也不能提升槽位。
  同轮复核还发现 CLI snapshot/change 投影失败有两处仍回退为 `unknown`、
  Server 缺少进程级启动指纹和关闭汇总、协议 shape trace 在超大对象上仍会
  扫描全部字段，以及远程消息读取自带 `hasOwnProperty` 会被恶意字段覆盖。
  以上项目纳入 R7 发布阻断并要求失败边界回归测试。
- 2026-07-29：App 诊断环损坏槽回归进一步确认，已提交窗口长度只能由
  单调 head 与容量推导，不能由仍可解析的物理槽数量反推；否则窗口中间
  一个损坏槽会错误截掉它之前仍有效的记录。恢复后按逻辑窗口过滤并跳过
  损坏槽，崩溃产生但未被 head 提交的槽仍必须排除。
- 2026-07-29：完整 App 并行测试中，225 条丢 invalidation 分页用例受同进程
  大文件加密负载影响从单独运行约 1 秒抖动到 7.5 秒，超过 Vitest 默认
  5 秒；生产断言与分页规模保持不变，只为该规模用例设置 15 秒有界预算，
  防止 CI 资源争用产生假失败。
- 2026-07-29：v3/v4 写入隔离复核确认现有测试仍只覆盖输出 guard 与源码
  正则，没有动态经过 `runCodex` 使用的 provider mapper 边界。整改为由
  `CodexLegacyOutput` 原子执行“判断 canonical 状态 -> 映射 -> 写 envelope”，
  reasoning、diff 和 provider event 三条实际链路统一调用，并用真实 mapper
  事件证明 v4 激活后不再映射或写入 v3。
- 2026-07-29：Server hostile error 复核发现 route 分类器虽已 fail-open，
  全局错误处理器仍会直接读取同一对象的 `statusCode`，恶意 getter 可在
  生成脱敏响应时再次抛出。Sync v4 全局错误响应必须防御性读取状态码，
  getter 失败固定回退 500，并通过真实 Fastify 请求验证不泄露错误原文。
- 2026-07-29：R7 最终差异审查确认 App change 在 projection 失败后的
  `exactReplay` 会再次投影，先落实体、后推进 cursor 的恢复边界成立；同时
  发现 CLI 默认 HTTP transport 虽由 Wire schema 拒绝
  `updatedSeq > highWatermark`，coordinator 却未像 App 一样对自定义
  transport 做二次防御。该一致性校验与绕过 transport parser 的回归测试
  列为提交前阻断项。
- 2026-07-29：App 诊断环的常态追加和 stats 已为 O(1)，但日志页读取仍以
  `getAllKeys()` 扫描整个独立 MMKV。整改为仅按 head/count 推导的已提交
  sequence 窗口直接读取 N 个确定槽位，并在构造边界硬限制计划声明的
  2,000 条最大容量；`getAllKeys()` 只保留给实例恢复与显式清理，避免诊断
  页刷新成本受无关或遗留 key 数量影响。
- 2026-07-29：共享 Socket.IO 路径复核发现 CLI `ephemeral` listener 直接
  读取未校验对象；`null`、hostile getter 或畸形 watermark 可让仅用于提示的
  invalidation 抛出并干扰进程。改为 Wire strict schema 的 fail-open
  `safeParse`，坏提示只被忽略，polling 继续承担正确性恢复，并增加不抛异常、
  不推进 Sync client 的回归测试。
- 2026-07-29：Server 传输安全指纹只读取 Fastify 的本地
  `request.protocol`，在反向代理终止 TLS 的生产部署中会把外部 HTTPS 错标为
  `insecureHttp`。改为优先从 canonical `PUBLIC_URL` 只派生固定安全枚举，
  不记录 URL/host/IP；配置缺失或无效时才回退到请求协议，并覆盖该代理场景。
- 2026-07-29：App 诊断页在“零合法记录但 sink 已累计 invalid/write/listener
  failure”时禁用复制与清除，恰好让最需要的终态摘要不可取得；成功清除也未
  重置内存计数。操作可用性改为同时考虑记录和失败计数，复制仍只输出严格
  JSONL + 固定摘要，成功清除重置本地 sink 统计且不触碰普通 console 日志。
- 2026-07-29：CLI 终止诊断复核发现 capability 失败、功能关闭和正常退出
  都在刷新异步诊断队列前读取统计，且正常退出只以 cleanup failure 判断
  `degraded`；诊断 sink 自身的 dropped、invalid 或 write failure 因而可能
  被结构化终态误报为正常停止。三条路径改为先 best-effort flush、再读取
  统计并统一判定退化；终态记录自身若写入失败，close 后的普通脱敏摘要继续
  提供最终计数兜底。
- 2026-07-29：binding 关闭链复核发现 `requestBroker.failPending` 或
  `mapper.close` 抛错会跳过后续 mapper flush / outbound flush；最后的
  Sync client 虽会关闭，尚未进入 durable journal 的尾部聚合 part 仍可能
  丢失。root 与 child binding 统一改为逐项 best-effort 执行 command
  processor、broker、mapper、outbound、Sync client 和 side session 关闭，
  全部尝试后再抛首个错误，并用每个边界失败仍执行其余步骤的测试阻断回归。
- 2026-07-29：App 终态字段复核发现 client/registry 已汇总 cursor、outbox
  depth 与 suppressed，但 MMKV sink 的 dropped、invalid、write failure 和
  listener failure 只在手工导出时出现，终止事件可能把已退化的诊断存储写成正常
  stopped。生产 wiring 增加只读 stats provider，client 与 registry 终态均
  写固定计数字段并据此标记 degraded；stats provider 自身失败只省略计数，
  不得抛入同步控制流。
- 2026-07-29：R7 本地发布门禁完成。Wire `65/65`、Server `110/110`
  （含 100,000 mutation chaos）、App `83/83` 文件及 `949/949`、Agent
  `227/227`、CLI 合计 `1073/1073` 单测通过；五包 typecheck、Wire/CLI/
  Agent bundle、production Web export 与 frozen lockfile 均通过。真实
  Codex -> CLI -> HTTP relay -> App 场景覆盖 WebSocket、丢 invalidation
  后 polling、重启、410 snapshot fallback、审批、child、跨端 trace 与
  payload-free 诊断，10k entity + 20 个 5 Hz delta 的 p95 为 `242.2 ms`。
  本机全局 `pnpm 11.9.0` 与仓库锁定版本不兼容，最终 frozen install 使用
  隔离缓存下的 `pnpm 10.11.0` 验证且未改写 lockfile。Server Bun runtime、
  Tauri fmt/check/test 和真实十分钟 turn 继续由本次 GitHub required jobs
  复验；历史 job `90372107716` 已证明十分钟权威完成门禁通过。
- 2026-07-29：提交 `a4e0236` 的 branch push CI `30425492797`、PR CI
  `30425494285`、CLI Smoke `30425494279` 与 main CI `30426187769` 全绿；
  CLI `1.4.5` release `30426187763` 成功并完成 tgz 验包。Android
  `1.11.10` release `30426187767` 在生成 APK 后的 manifest cleartext
  introspection 失败。差异确认 Expo 55 的 `Android` 配置类型和 prebuild
  不消费任意 `android.usesCleartextTraffic` 字段：该值只进入
  `assets/app.config`，未进入最终 manifest。修复改为专用
  `withAndroidManifest` config plugin，并在耗时 Gradle 编译前增加生成态
  manifest 结构化门禁；最终 APK grep 失败必须输出具体断言而非静默退出。
  失败版本不复用，App 推进到 `1.11.11` 后重新运行完整 CI 与 Android release。
- 2026-07-29：Android manifest 修复本地门禁完成。production Expo prebuild
  生成的 `<application>` 已包含 `android:usesCleartextTraffic="true"`，OTA
  enabled metadata 为 false 且 update URL 不存在；专用结构化 verifier
  通过。App `84/84` 文件、`952/952` 单测、typecheck、production Web
  export、HTTP 平台配置、四个 workflow YAML 和 `git diff --check` 全部通过。
  最终 APK 的包名、版本、SDK、ABI、manifest、签名和 16 KiB 校验继续由
  App `1.11.11` 云端 release 执行。
