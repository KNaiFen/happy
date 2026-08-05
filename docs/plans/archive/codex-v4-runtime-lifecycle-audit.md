# Codex V4 运行生命周期审计

> **历史归档（2026-08-05）：** 审计实施已结案；本文件保留证据，不再作为活动任务清单。

## 状态

- 调查完成并已实施（2026-08-04）：保留 `4ce11a45` 的现场结论作为历史基线；修复由后续 Relay、CLI 和 App 提交实现。
- 实施版本：Relay `1.1.39`、CLI `1.4.39`、App `1.11.25`；Wire 与 happy-agent 未改动。
- 验证边界：本地只运行 TypeScript/Vitest 源码检查；发布工作流、官方 Codex 集成、真实 PTY 11 分钟空闲和 Android App 现场路径均由云端运行验证，不把本地检查冒充发布证据。
- 范围：Codex V4 的创建、恢复、运行、断线、重连、停止、归档、列表投影，以及 App、CLI、daemon、Gateway、Relay Server 之间的状态交接。
- 目标：保留现场调查结果，记录 F1-F10 的代码与测试证据，并明确尚待现场确认的外部退出诊断边界。

## 必须成立的不变量

1. 正在运行且可继续交互的 Codex V4 会话不能仅因十分钟内没有旧版心跳而变成非活跃。
2. `active=false`、显式归档、运行结束、传输断开和 App 离线是不同状态，不能互相推断。
3. App 退出或用户 Socket 断开不能停止 daemon、App-origin headless Gateway 或 provider turn。
4. 只有权威 provider 生命周期或对账快照可以结束执行；超时、RPC ACK、transport loss 都不能代替它。
5. 显式归档必须先完成停止与持久化，再从默认列表隐藏；旧写入不能复活归档墓碑。
6. 任意恢复入口都必须得到同样的 V4 绑定、活跃状态和展示结果。
7. daemon、Gateway 或网络异常后，恢复流程不能创建双写 writer，也不能丢失正在执行的 turn。

## 实施关联（2026-08-04）

下表将每个调查发现连接到当前代码和回归测试。除 F3 外，状态均表示源码级实现和测试已覆盖；不把本地测试等同于云端现场验收。

| 发现 | 当前状态 | 代码关联 | 测试关联 |
| --- | --- | --- | --- |
| F1 presence 超时 | 已修复 | `happy-server/.../sessionRoutes.ts`、`presence/timeout.ts`、`eventRouter.ts`；`happy-cli/.../codexGatewayPresence.ts`、`codexGatewayRuntimeFactory.ts`、`codexGatewayWorker.ts` | `timeout.spec.ts`、`sessionRoutes.machineOrigin.spec.ts`、`codexGatewayPresence.test.ts`、`codexGatewayWorker.test.ts` |
| F2 三态投影混淆 | 已修复 | `storageTypes.ts`、`apiTypes.ts`、`sync.ts`、`sessionLifecycle.ts`、`SessionsList.tsx`、`recent.tsx` | `apiTypes.spec.ts`、`sessionLifecycle.test.ts`、`activityUpdateAccumulator.test.ts`、`useVisibleSessionListViewData.spec.ts`、`settings.spec.ts` |
| F3 daemon/Gateway 外部消失 | 仍待诊断 | `codexGatewayWorker.ts`、`codexGatewayState.ts` 仅增加不含载荷的受控启动、正常退出、provider 退出、控制通道错误与最后心跳记录 | `codexGatewayWorker.test.ts` 覆盖 descriptor 生命周期写入；没有证明外部进程消失的原因 |
| F4 顶层 Resume 失效 | 已修复 | `resume/handleResumeCommand.ts`、`codexGatewayResume.ts`、`codexGatewayWorker.ts`；App `resumeCommand.ts` | `handleResumeCommand.test.ts`、`codexGatewayResume.test.ts`、`codexCommand.test.ts`、App `resumeCommand.test.ts` |
| F5 live Gateway 恢复假成功 | 已修复 | `codexGatewayResume.ts`、`codexGatewayLauncher.ts`、`daemon/run.ts` | `codexGatewayResume.test.ts`、`codexGatewayLauncher.headless.test.ts`、`codexGatewayLauncher.liveness.test.ts` |
| F6 两秒 heartbeat 写放大 | 已修复 | `codexGatewayWorker.ts`、`codexGatewayCoordinator.ts`、`codexGatewayState.ts` | `codexGatewayWorker.test.ts` 断言 descriptor heartbeat 不重写 runtime binding |
| F7 PID 复用误判 | 已修复 | `codexGatewayLauncher.ts`、`codexGatewayProcessIdentity.ts`、`daemon/run.ts` | `codexGatewayLauncher.liveness.test.ts`、`codexGatewayProcessIdentity.test.ts` |
| F8 僵尸 binding 无法归档 | 已修复 | App `sessionArchiveCoordinator.ts`、`ops.ts`；CLI `apiMachine.ts`、`daemon/run.ts` | `sessionArchiveCoordinator.spec.ts`、`ops.codexQueue.test.ts`、`apiMachine.codexFork.test.ts` |
| F9 child 停止后仍 active | 已修复 | `codexGatewayRuntimeFactory.ts`、`codexV4ThreadRouter.ts`、`codexGatewayCoordinator.ts` | `codexGatewayRuntimeFactory.test.ts`、`codexV4ThreadRouter.test.ts`、`codexGatewayCoordinator.test.ts` |
| F10 provider child 关闭破坏同步 | 已修复 | App `sideChatSessions.ts`、`SessionView.tsx`、`sessionArchiveCoordinator.ts`、`ops.ts` | `sideChatSessions.test.ts`、`sessionArchiveCoordinator.spec.ts`、`ops.codexQueue.test.ts` |

### F3 诊断边界

F3 仍是现场异常，而不是已确认的代码缺陷根因。当前证据只能证明当时 daemon 与 detached Gateway 缺少正常退出记录，不能归因于 daemon、自身清理、系统终止、升级替换或其他外部事件。新增 descriptor 生命周期记录用于下次现场关联，但不得据此反推或宣称已经确认 daemon 消失原因。

## 实施前已确认调查结果（历史基线）

### F1：V4 活会话约十分钟后会被旧 presence 超时置为非活跃

- 严重度：严重。
- 证据链：
  - 外部 Codex 历史线程通过 `openCodexThread()` 创建或绑定 Happy V4 会话。
  - `CodexGatewayRuntimeFactory.tryCreate()` 启动时只调用一次 `api.unarchiveSession(session.id)`。
  - `0a325dc3` 移除了 CLI 的 `ApiSessionClient.keepAlive()` 与 Server 的 `session-alive` 路由。
  - `packages/happy-server/sources/app/presence/timeout.ts` 仍按十分钟未更新的 `lastActiveAt` 将会话写成 `active=false`。
  - V4 mutation、ACK、poll、snapshot 路由都不刷新该 presence 时间。
- 结论：这是 V4-only 迁移后留下的状态生产者/消费者断裂，不符合产品预期。

### F2：App 把所有非活跃会话显示成“已归档”

- 严重度：高。
- 证据链：
  - Relay 的 `sessionResponse()`、`/v1/sessions`、`/v2/sessions` 都不返回数据库中的 `archivedAt`。
  - App `Session` 类型、拉取响应类型和 storage 因而没有真实归档字段可用。
  - `useVisibleSessionListViewData.ts` 依据 `session.active` 分组。
  - `active=false` 的分组由“显示已归档”控制并使用归档语义展示。
  - 该投影不可能检查真实的 `archivedAt`。
- 结论：presence timeout、正常停止、进程丢失和显式归档都被压缩为同一个 App 状态；前者会被误报为显式归档。

### F3：现场中的 daemon 与 detached Gateway 后续均异常消失，原因尚未确认

- 严重度：待定，作为独立异常保留。
- 现场证据：
  - daemon 于 10:45 接收 `codex-open-thread`，日志持续到 13:07。
  - detached Gateway 持续产生 V4 ACK/投影直到 13:07。
  - 两份日志均没有正常关闭、信号处理或错误终止记录，之后对应进程均不存在。
- 已排除：退出手机 App 只会断开用户 Socket，按实现不应直接停止 daemon 或 headless Gateway。
- 尚未排除：手工/系统级进程终止、daemon 清理路径、worker 监控误判、升级替换或其他外部事件。
- 注意：即使进程一直存活，F1 也会在约 10 分钟时先把会话置为非活跃；两者不是同一故障。

### F4：`happy resume <happy-session-id>` 在 V4-only 下必然失败

- 严重度：高。
- 证据链：
  - 顶层 `happy resume` 仍调用 `handleResumeCommand()`。
  - `buildResumeLaunch()` 生成 `happy codex --resume <threadId>`，并可能继续生成 `--started-by`、`--permission-mode`、`--effort`。
  - 当前 `planCodexCommand()` 明确把这些参数都列为已移除的 Happy adapter 参数并抛错。
  - 两侧各自的单测都通过，却没有跨入口测试把 `handleResumeCommand()` 的 child argv 送入 `planCodexCommand()`。
- 结论：这是 V4-only 收敛后遗留的公开 CLI 入口；它不能恢复旧 Happy V4 会话，且即使只放开 `--resume` 也不会复用原会话的独立数据密钥。

### F5：F1 触发后，两个恢复入口会把仍在运行的 Gateway 误判为“过渡中”或只做假成功

- 严重度：高。
- 证据链：
  - `resumeSession()` 发现 live Gateway 后直接返回 success，不调用 `unarchiveSession()` 或任何 session activity 写入。
  - App 快捷恢复随后刷新列表，Relay 仍保持 `active=false`。
  - 设备历史选择器的 `openExisting()` 用 `snapshot.active=false + liveSessionForId()=true` 得到 `process-transition`，返回“上一个进程仍在关闭”的错误。
  - 这里的 live Gateway 正是 F1 中仍持续 ACK/投影的 Gateway，不是实际关闭过程。
- 结论：presence 失真不仅影响首页展示，还会反过来阻断或伪完成恢复操作；恢复入口必须把已验证的 live Gateway 当成比旧 `active` 位更强的事实，并同步恢复 presence。

### F6：Gateway 心跳每两秒持续写入会话元数据和 V4 流

- 严重度：高（写放大与恢复压力）。
- 证据链：
  - `HEARTBEAT_MS = 2_000`。
  - 每个 `heartbeatOnce()` 调用 `materializeDeferredRoots()`。
  - 即使没有 deferred root，`materializeDeferredRoots()` 仍调用 `coordinator.refreshBindingLinks()`。
  - `refreshBindingLinks()` 对 current/draining root 生成新的 `changedAt` 并调用 `runtime.updateBinding()`。
  - `runtime.updateBinding()` 依次更新 metadata、Gateway runtime projection、mapper、outbound transport；`changedAt` 每次不同，无法被无变化优化消除。
  - 现场日志中 metadata version 与 V4 ACK/投影约每两秒增长，和该路径一致。
- 结论：descriptor 健康检查被错误地变成了会话业务状态写入；空闲 Gateway 也会制造无限 metadata version、mutation journal、网络和电量开销，并提高后续快照/恢复压力。
  - 量级：单一空闲 root 至少约 43,200 次/天的绑定写入；`JOURNAL_MINIMUM_RECENT_RECORDS = 100,000`，约两天多就足以开始推动 journal 压缩窗口。

### F7：设备历史恢复把“PID 存在”误当成“目标 Happy Gateway 仍存在”

- 严重度：中。
- 证据链：
  - daemon 的 `liveSessionForId()` 只用 `process.kill(pid, 0)` 检查 `tracked.pid` 或旧 `metadata.hostPid`。
  - 持久化会话记录会跨 daemon 重启保留 `hostPid`。
  - 同一仓库已有 `isExpectedCodexGatewayWorkerProcess()`，会验证 worker argv 和 gateway ID，但该恢复判断没有使用它。
- 结论：PID 被系统复用后，任意无关进程都可能把可恢复历史误判为仍在运行，导致错误的 `existing-active` 或 `process-transition` 结果。

### F8：异常死亡后仍标为 current/recovering 的会话无法在 App 中归档

- 严重度：中。
- 证据链：
  - App 的 `sessionArchiveCoordinator` 只要 metadata binding role 为 `current` 或 `recovering`，就强制先发 Gateway stop。
  - worker 崩溃/被杀时，最后一次同步 metadata 仍可能是 `current`；Relay timeout 只改 `active=false`，不改 binding role。
  - daemon `stopSession()` 找不到 Gateway 时返回失败，App 因而拒绝发送权威 archive tombstone。
  - 现有测试只覆盖 binding 已经是 `inactive` 的历史，未覆盖“worker 非正常消失但 binding 仍 current”。
- 结论：异常路径会留下既不能恢复为活跃、也不能从 App 显式归档的孤儿会话。

### F9：root 正常停止时 child session 仍会在 Relay 上保持 active

- 严重度：中。
- 证据链：
  - graceful Gateway stop 只对 root 调用 `updateBinding(role='inactive')`，并由 root runtime 写 archive tombstone。
  - `CodexV4ThreadRouter.close()` 与 terminal-child resource release 只调用 child binding 的 `close()`。
  - child binding 的 `close()` 只关闭 command processor、request broker、mapper、Sync v4 client 和 session transport，不写 Relay archive 或 presence 状态。
  - `archiveSessionV4()` 的生产调用只注入 root runtime；child 创建时只有一次 `unarchiveSession()`。
  - App `useSideChatSessions()` 又只按 `session.active` 决定 child 是否仍是可见 side chat。
- 结论：root 已经正常停止、child 已经没有运行时 owner 后，child 仍会被展示为 active，直到十分钟 presence timeout 兜底；正常关闭不能依赖崩溃超时收敛。

### F10：关闭 provider child 绕过只读生命周期门禁并切断后续投影

- 严重度：高。
- 证据链：
  - 当前持久决策要求 provider-created child 不暴露 write、fork、resume、kill、archive、delete 路径；关闭 side panel 只改变本地视图。
  - 详情页确实隐藏 provider child 的 archive/delete，但 `SessionView.closeSideChat()` 与 `closeAllSideChats()` 会对所有 side chat 调用 `archiveSession()`。
  - `sessionArchiveCoordinator` 对 `codexReadOnly=true` 只跳过 kill，仍直接调用 `sessionArchive()`；现有测试还把“read-only child 会 archive、不会 kill”固化为通过条件。
  - child 与 parent 共用 provider 进程，Relay tombstone 不会停止对应 provider thread。
  - child 的下一批 V4 mutation 会收到 `sessionArchived`，随后停止该 Sync v4 client；RuntimeFactory 只给 root target 注册了 archive lifecycle callback，没有给 child binding 注册相应的释放/对账处理。
- 结论：用户关闭 provider child 后，provider thread 可以继续运行，但该 child 的后续远端投影被 archive tombstone 拒绝。这既违反既定只读生命周期边界，也可能留下不可见的活动工作与停止同步的 child binding。

### C1：不能通过删除 session timeout 来修 F1

- 类型：修复约束，非独立线上结论。
- 证据链：worker 的 `SIGTERM`/`SIGINT` 走 `requestShutdown(true)`；force stop 直接 `finalizeStop()`，跳过 graceful `role=inactive` 与 Relay archive。
- 结论：当前 timeout 同时承担“异常或 force 停止后的最终失活”职责。正确修复必须补上 V4 活动来源，同时保留或替换异常死亡的失活机制；不能只取消十分钟 timeout。

## 实施前端到端线路（历史基线）

```text
设备页输入目录并选择历史线程
  -> happy-app.openCodexThread()
  -> daemon codex-open-thread
  -> CodexThreadOpenCoordinator.createExternal()/openBound()
  -> Happy V4 session + thread binding
  -> detached Codex Gateway worker (headless)
  -> CodexGatewayRuntimeFactory.tryCreate()
  -> unarchiveSession() [仅启动时]
  -> V4 mutation/ACK/poll/snapshot [不更新 lastActiveAt]
  -> Server presence timeout [10 分钟]
  -> active=false
  -> App inactive 分组
  -> “显示已归档”中的会话
```

## 实施前审计矩阵（历史基线）

| 线路 | 入口 | 运行所有者 | 断线/退出 | 恢复入口 | 停止/归档 | App 投影 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| App 新建会话 | `spawnSession` -> daemon -> headless Gateway | Gateway | App Socket 断开不停止 | F1/F5 影响 | stop-before-archive；异常时 F8 | F1/F2/F6 | 有缺陷 |
| App 恢复已绑定历史 | 已确认 | Gateway | App Socket 可断 | F5 有误判 | F5 有误判 | F1/F2/F5 | 有缺陷 |
| App 接管外部历史 | `openCodexThread` -> detached Gateway | Gateway | App 退出不停止 | F1/F5 影响 | stop-before-archive；异常时 F8 | F1/F2/F6 | 有缺陷 |
| CLI 新建/恢复 | 新建已确认；恢复为 F4 | terminal Gateway / 旧 child adapter | normal exit graceful；异常 detach | `happy resume` 失败 | root 可 graceful archive；child 有 F9 | F2/F4 | 有缺陷 |
| TUI `/resume`、`/new`、`/fork` | 已确认 | 同一 Gateway | 异常 detach 不结束执行 | 已有 picker 代理测试 | normal exit 归档 | binding handoff | 当前未发现同类缺陷 |
| App 重复/分叉/子线程 | root handoff、独立 user fork、provider child | Gateway / child binding | App 断开不停止 | root 受 F1/F5；provider child 不可独立恢复 | F9/F10 | F1/F2/F9/F10 | 有缺陷 |
| daemon/Gateway/provider 异常 | 已确认 | recovery / provider adoption | F3 待定 | 60 秒 daemon discovery | C1 依赖 timeout | F8 | 有缺陷/待定 |
| 显式停止/归档/设备删除 | 已确认 | App + daemon + Relay | 无 worker 时 F8 | 设备删除保持不可写；恢复受 F5/F7 | archive tombstone | F2/F8 | 有缺陷 |

## 实施前全线路审计结论（历史基线）

- 旧 heartbeat 遗留只在 session presence 形成已确认断裂；machine presence 与 Gateway descriptor 仍有独立生产者，但 descriptor heartbeat 被 F6 错接到业务 metadata/V4 写入。
- App quick resume、设备历史 openExisting、daemon discovery 和顶层 `happy resume` 没有统一的 V4 恢复后置条件；F4/F5/F7 是同一入口分叉问题的不同表现。
- `active=false`、explicit archive、normal stop、worker loss 仍被 Relay API 与 App 投影混用；F2/F8/F9 覆盖 root、异常和 child 三种结果。
- `active=false` 不会阻断 V4 changes/snapshot 读取；archive tombstone 会拒绝新 mutation，但保留读取，因此当前未发现因 inactive 本身导致 journal replay/snapshot 丢失的同类缺陷。
- parent runtime 选择由 `metadata.codexThreadId` 隔离，现有定向测试未发现 child 迟到 mutation 覆盖 parent 当前执行态；child 缺陷集中在 presence 与 lifecycle 操作，而非投影 owner 选择。
- TUI attachment、root handoff、draining source 与权威 provider completion 的现有路径未发现新的“用超时推断 turn 完成”行为。
- F3 的 daemon/Gateway 无日志消失仍没有代码内权威原因；它继续作为现场异常保留，不能拿 F1 的确定修复代替调查。

## 实施前已验证的非回归线路（历史基线）

- 官方 Codex TUI `/resume` picker：Gateway TUI relay 有初始化和 `thread/list` 覆盖，定向测试通过。
- App Queue/Steer：执行中的发送带入显式 `followUpMode`；命令构造只会产生 `turn.queue` 或具备活动 turn 的 `turn.steer`，定向测试通过。
- 正常 terminal attachment 退出：terminal-origin worker 经 `normalExit -> requestShutdown(false) -> deactivateRootsForGracefulStop -> archive`；App-origin attachment 正常退出回到 headless，不会停止 worker。

## 实施前本轮验证（历史基线）

- CLI/Gateway：8 个测试文件、132 项通过。
  - 覆盖 `codexCommand`、`handleResumeCommand`、Gateway coordinator、worker、runtime factory、sync runtime、thread router、TUI relay。
- Relay Server：3 个测试文件、45 项通过。
  - 覆盖 presence cache、machine-origin session route、V4 session route。
- App：5 个测试文件、56 项通过。
  - 覆盖 thread history、archive coordinator、V4 capabilities、V4 command、V4 projection。
- 合计：16 个测试文件、233 项通过。
- 已发现的测试缺口：
  - `happy resume` child argv 与 `happy codex` 路由的组合测试。
  - idle Gateway heartbeat 不产生 metadata/V4 mutation 的断言。
  - `archivedAt` 与 `active=false` 在 Relay API、storage、列表 UI 中的区分。
  - presence timeout 后，live Gateway 的 App quick resume 与设备历史恢复。
  - worker 异常消失但 metadata role 仍为 current/recovering 时的 App archive fallback。
  - PID 复用或命令行不匹配时的 bound-thread liveness 判定。
  - root graceful stop 显式收敛所有 provider child presence，且不依赖 timeout。
  - provider child 关闭侧栏不得调用 archive/kill，writable user side chat 仍执行 stop-before-archive。

## 已实施状态模型

```text
active=true  + archivedAt=null  -> 活跃
active=false + archivedAt=null  -> 非活跃、可恢复
archivedAt!=null                -> 显式归档
```

- Gateway binding 以独立 Presence lease claim/touch/release 维护第一种状态；正常退出、超时和崩溃只进入第二种状态。
- Archive 原子写 tombstone 并清除租约；Unarchive 只清 tombstone，保持 inactive，必须由 Gateway claim 后才变 active。
- Socket.IO 只作为刷新提示；Relay 状态由租约、快照和持久队列决定。旧 activity/snapshot 不能覆盖 tombstone，显式较新的 unarchive 才能清除它。
- provider-created child 只读、不可 Resume/Fork/Kill/Archive/Delete；关闭侧栏只变更本地可见状态，inactive 且未归档的 child 可从父会话侧栏历史回看。

## 实施约束与云端验收

下面的约束已由本轮代码实现；验收矩阵由云端源码测试、官方 Codex 真实 PTY 和 Android 现场运行共同覆盖，证据列在矩阵之后。

```text
Gateway 存活（本地 descriptor）
  -> Gateway-owned V4 presence touch（低频、machine-auth、无 payload）
  -> Relay: archivedAt=null 时更新 active/lastActiveAt
  -> App: active 表示在线，archivedAt 表示显式归档

Gateway 正常停止
  -> flush + release presence lease + role=inactive
  -> App inactive/可恢复历史

Gateway 异常死亡/force stop
  -> 不再有 presence touch
  -> Relay timeout 仅把会话标为 inactive
  -> App inactive/可恢复分组，不能伪称 archived
```

1. 保留异常失活机制。不能删除十分钟 timeout；Gateway 活动要通过独立、低频、V4 machine-auth 的 presence touch 续期，不能依赖 Socket.IO，也不能依赖 metadata 或 V4 mutation 写入。
2. presence touch 覆盖 root 和仍在观察/投影的 child session。只修 root 会让运行中的 side chat 继续在十分钟后消失。
3. touch 必须拒绝 `archivedAt != null`，并且 archive/unarchive 与 touch 之间采用单调时间和墓碑条件，避免旧 worker 复活已归档会话。
4. Gateway descriptor heartbeat 与 `refreshBindingLinks()` 解耦。只有 root 关系、generation、role、terminal 状态或目标 session ID 实际变化时才能更新 metadata/V4 entity；两秒 heartbeat 只能刷新本地 descriptor。
5. 所有“已验证 Gateway 仍活着”的恢复入口必须恢复 Relay presence：App quick resume、设备历史 `openExisting`、daemon 重启后的 Gateway discovery、CLI 本地恢复。不能以旧 `snapshot.active` 覆盖 descriptor/worker 的权威证据。
6. `happy resume` 必须替换旧 Happy adapter child argv，改走明确的 V4 resume 流程，并把同一 session ID 与数据密钥交给 Gateway；不得仅放开被删除的 CLI 参数，也不得重新创建第二个 Happy session。
7. liveness 判定必须优先验证 descriptor/control endpoint，退化 PID 检查必须验证 worker identity（gateway ID + argv），不能单独使用 `kill(pid, 0)`。
8. App archive 在 confirmed missing worker 的情况下必须能写 Relay tombstone；Gateway 仍可验证为活着时则继续坚持“先 stop、后 archive”的顺序。
9. Relay session list 必须序列化 `archivedAt`；App storage 和 UI 必须把三种情况单独处理：online、inactive/recoverable、explicitly archived。设置项与文案也要匹配实际含义。
10. Gateway 正常停止或释放 terminal child 时，必须显式收敛每个 provider child 的 Relay presence；不能只关闭本地 binding 后等待通用 timeout。
11. provider-created child 的 panel close 只能改变本地可见状态，不得写 archive/kill/delete；用户显式创建的 writable side chat 继续遵循独立 Gateway 的 stop-before-archive 生命周期。

## 修复验收矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| App 新建后空闲超过 11 分钟 | headless Gateway 存活时会话仍 active，metadata/V4 seq 不按 2 秒增长 |
| App 接管外部历史后退出手机 App | daemon/Gateway/provider 不停止；11 分钟后会话仍 active |
| live Gateway 被 timeout 之前的旧状态污染 | App quick resume 与设备历史恢复恢复 presence，不报 process-transition，不创建第二 writer |
| `happy resume <id>` | 复用原 Happy V4 ID、数据密钥和 Codex thread，不传旧 adapter 参数 |
| TUI `/resume`、`/new`、`/fork` | picker 可用；root handoff 仅在状态变化时更新 binding；旧 draining root 只在权威完成后 archive |
| 运行中的 child/side chat 超过 11 分钟 | child 仍可见且 read-only，不覆盖 parent runtime |
| root graceful stop，存在 provider child | root 与 child 都立即收敛到正确 lifecycle，不等待十分钟 timeout |
| 关闭 provider child panel | 只隐藏本地视图，不 archive/kill，共享 provider 与后续投影保持一致 |
| 关闭 writable user side chat | 只停止并归档该 side chat 的独立 Gateway，不影响 parent |
| Gateway `SIGTERM`/force stop/worker 崩溃 | 不宣称 provider 已完成；最终变 inactive 而非 archive，后续可恢复或显式 archive |
| worker 非正常消失，metadata 仍 current | App 可以在确认 worker 不存在后显式 archive；存活 worker 仍受 stop-before-archive 保护 |
| 显式 archive 与旧 presence touch 竞争 | archive tombstone 获胜，旧 touch 不能复活会话 |
| PID 被复用 | 不阻断正确恢复，也不把无关进程视为 Happy Gateway |

### 云端验收证据（2026-08-04）

- 产品实现提交 `12018c34` 的 monorepo CI `30909024720`、CLI `1.4.39` 发布 `30909024377`、Relay `1.1.39` 发布 `30909023469`、Android App `1.11.25` 发布 `30909023316` 和官方 Codex Android 现场验收 `30909025246` 均成功。
- 验收补强提交 `be685ae1` 的 monorepo CI `30912025575` 成功。其真实 PTY 场景在 terminal 异常断开后等待 11 分钟，确认 Relay session 仍 active，Gateway/provider/worker 仍存活，且 gateway、provider、thread、session 与 generation 均未发生交接；随后继续覆盖 attach 与正常停止。
- 同一提交的 API 36 官方 Codex Android 现场验收 `30912026216` 成功，覆盖 App 往返与恢复路径。租约接管、旧 touch/归档竞争、超时/touch 竞争、root/child release、missing worker、强制停止和 PID 复用由上述云端源码测试作业覆盖。
- 这些成功运行没有证明 F3 的外部 daemon/Gateway 消失原因；F3 继续保持“仍待诊断”，只能由后续不含载荷的 descriptor 生命周期记录补充证据。

## 验证策略

- 先用 CodeGraph 建立所有入口和调用链，再读关键实现。
- 用状态转换表逐项检查数据库字段、descriptor、binding、provider execution、Socket 和 App 投影。
- 运行最小范围的源码级测试；不在本地构建 CLI、App、Server、Codex source 或 release artifact。
- 每个发现标为“已确认缺陷”“现场异常”“设计风险”或“测试缺口”，避免混淆。
