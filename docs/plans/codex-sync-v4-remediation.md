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
- [ ] orphan notification 进入持久 FIFO，绑定失败可重试并最终 snapshot
      对账。
- [x] 进程退出恢复所有 active thread，不依赖 selected thread。
- [ ] 区分 provider child、用户 fork、detached review 和 sibling 通信。
- [x] turn/thread 状态单调，旧 turn 完成不能结束另一个 active turn。
- [x] interrupt 超时只触发重连协调，不直接产生权威 completed/idle。
- [x] resume 不使用陈旧配置放宽 approval/sandbox 权限。
- [x] server request handler 总是返回 response 或协议 error。
- [x] provider request 的 pending、response-ready、supplied、resolved 和
      outcome-unknown 状态可跨进程恢复。
- [ ] stable-v2 UserInput 和 ThreadItem 使用 exhaustive mapper；未知 stable
      variant 产生受控诊断而不是空 item。
- [ ] warning/error ID 跨重启不碰撞，错误码保持结构化。
- [ ] finalized stream 释放大内容，snapshot 批量投影避免重复发布。

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

R3 分为四个可独立验证的提交：

1. mapper durable publication boundary、迁移 `activating` 恢复和
   snapshot/live barrier；
2. thread/turn 单调状态、全部 active thread 恢复、interrupt 权威协调和
   conservative resume policy；
3. provider request 五态持久恢复，以及 server request 必答/协议错误；
4. orphan durable FIFO、provider child/user fork/detached review/sibling 分类、
   stable-v2 exhaustive item/input mapper、诊断 ID 与 stream/batch 内存治理。

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
- 2026-07-28：R3 第二切片完成全部 active thread 的保守恢复、selection
  隔离、turn/thread 单调合并和 interrupt 权威协调；`turn/interrupt` 的
  `{}` ACK 不再被视为终态，pending start 也通过 registry completion 对账。
- 2026-07-28：R3 第三切片细化 provider request 为 pending、
  responseReady、responseSupplied、resolved 和 outcomeUnknown 五态；
  unknown/失败的 server request 必须返回 JSON-RPC error。
  dependency audit job 不启用无依赖安装场景下的 pnpm cache；CI、Smoke
  Test 和版本构建工作流统一使用 Node 24 runtime 对应的 action 版本。
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
