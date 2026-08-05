# Codex 生产执行链审计与修复台账

## 文档状态

- 审计基线：`a3f73cb46e7e6bc27fa00a1f29af7181354321cc`
- 建立日期：2026-08-05
- 范围：App、Relay/Wire、CLI/Gateway、happy-agent 的生产执行链
- 排除项：安全、认证授权、密码学、隐私、依赖漏洞、纯风格和无生产矛盾的覆盖率建议
- 回归基线：`docs/plans/codex-v4-runtime-lifecycle-audit.md` 中 F1-F10 均视为已修复；本台账不重复报告。原 F3 仍为未归因现场异常。
- 当前状态：修复进行中

## 执行规则

本文件是本轮修复的唯一状态清单。项目严格按下表顺序处理；同一严重度按生产影响和不变量破坏范围排序。

每一项必须依次经历：

1. 从本文件选择编号最小的“待修复”项目。
2. 在当前 HEAD 上复核生产路径、保护逻辑、测试和触发交错。
3. 确认问题仍真实后，将状态改为“进行中”；若已不可复现，则记录反证并改为“已驳回”。
4. 写出该项的实施与验证计划，然后修改代码。
5. 完成本地最小验证、变更审查和适用的 GitHub CI。
6. 以独立分支和原子提交推送，通过 PR 合并到 `main`。
7. 合并后记录提交、PR、CI 和验证证据，将状态改为“已解决”。
8. 再选择下一项，不并行修改多个审计问题。

状态只允许使用：`待修复`、`进行中`、`已解决`、`已驳回`。

## 优先级清单

| 顺序 | 编号 | 严重度 | 置信度 | 状态 | 标题 |
| ---: | --- | --- | --- | --- | --- |
| 1 | F-01 | P1 | 高 | 已解决 | happy-agent 把命令结果或 interrupt ACK 当作 turn 终态 |
| 2 | F-02 | P1 | 高 | 进行中 | happy-agent 写操作缺少跨进程持久幂等凭据 |
| 3 | F-03 | P1 | 高 | 待修复 | Gateway handoff 失败会留下目标 generation 的 current 元数据 |
| 4 | F-04 | P2 | 高 | 待修复 | App snapshot 替换会覆盖并发发布的本地乐观投影 |
| 5 | P-01 | P2 | 高 | 待修复 | App 为全部 Codex 会话启动固定 5 秒轮询 |
| 6 | P-02 | P2 | 高 | 待修复 | Relay mutation 在 Serializable 事务内逐条执行 ORM 写入 |
| 7 | P-03 | P3 | 高 | 待修复 | happy-agent 等待循环每秒重新拉取完整 snapshot |

## F-01 happy-agent 把命令结果或 interrupt ACK 当作 turn 终态

- 状态：已解决
- 严重度：P1
- 置信度：高
- 生产链：`packages/happy-agent/src/index.ts:313 send` -> `packages/happy-agent/src/session.ts:249 sendMessage` -> `packages/happy-agent/src/session.ts:293 waitForCommand` -> `packages/happy-cli/src/codex/codexV4CommandProcessor.ts:192 execute` -> `packages/happy-cli/src/codex/codexAppServerClient.ts:2223 turn/start`
- 被破坏的不变量：RPC ACK、command result 和 interrupt ACK 都不能推断 provider turn 已完成；只有权威 provider lifecycle 或对账 snapshot 可以结束执行。
- 触发交错：`turn/start` 立即返回并产生成功 command result，provider 仍在 streaming；`happy-agent send --wait` 随即退出。`stop` 收到 interrupt RPC ACK 后也立即报告停止，或者在 runtime 状态未知且没有可见 active turn 时报告停止。
- 用户影响：自动化会在模型仍运行时继续后续步骤；停止命令可能假报成功，导致并发写入、状态覆盖或错误清理。
- 已排除保护：`SessionClient.waitForIdle` 会拒绝 `statusUnknown`，但 `send --wait` 和 `stop` 当前未使用它；现有 command-result 测试只证明命令被接收。
- 最小复现：让 command result 先于 runtime idle snapshot 出现，断言 CLI 不得在 idle snapshot 前返回；让 snapshot 为 `statusUnknown` 且无 active turn，断言 stop 不得报告已停止。
- 当前覆盖：happy-agent 单测覆盖 command result 和独立 `waitForIdle`，没有覆盖两阶段等待或未知状态 stop。
- 最小修复方向：让等待型 send 和已发布 interrupt 的 stop 在 command result 后继续等待权威 idle；无 active turn 时只允许已知 idle 快速成功。
- 实施计划：在 `SessionClient` 中增加共享超时预算的“command result 成功、该 result 的 `turnId` 已观测到终态且 snapshot 已知 idle”等待方法；`send --wait` 和已发布 interrupt 的 `stop` 使用该方法，未发布 interrupt 的 `stop` 也调用 `waitForIdle`，因此 runtime 缺失或 `statusUnknown` 时不能假报停止。等待循环将剩余预算传给 snapshot 请求并限制 delay。补充 command result 早于目标 turn 生命周期、unknown snapshot 先于 idle、interrupt 以及已知 idle 的回归测试。`0.1.5` 发布测试暴露真实时钟下的错误精确次数断言后，按失败版本不可复用规则修正断言并推进至 `0.1.6`。
- 解决证据：行为修复由 PR #3 合并为 `659e90583a9297e8aa5c6bc3ccf9d7fc9d4f4fd0`，发布测试与版本修正由 PR #4 合并为 `e2cd9788a85ee52ff3e3eb8639779292e98bb998`。本地 happy-agent 10 个测试文件、178 tests 全部通过，`tsc --noEmit` 与 `git diff --check` 通过。PR #4 的 push/PR 工作流 `30972788354`、`30972790180` 共 34 项检查全部通过，两套官方 Codex TUI Gateway 真实 PTY 回环分别用时 13:08、12:57，两套 Required CI gate 均通过。主分支发布工作流 `30973559091` 成功完成源码验证、归档元数据与源码提交校验、安装后 CLI 烟测并上传未过期制品 `happy-agent-0.1.6`。失败的 `0.1.5` 发布运行 `30971433212` 已由 `0.1.6` 明确取代。

## F-02 happy-agent 写操作缺少跨进程持久幂等凭据

- 状态：进行中
- 严重度：P1
- 置信度：高
- 生产链（send）：`packages/happy-agent/src/index.ts:313` -> `packages/happy-agent/src/session.ts:319 publishCommand` -> `packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts:394 POST mutations`。
- 生产链（spawn）：`packages/happy-agent/src/machineRpc.ts:82 spawnSession` -> `packages/happy-cli/src/api/apiMachine.ts:201 operationId` -> `packages/happy-cli/src/codex/codexGatewayLauncher.ts:149 randomUUID fallback`。
- 被破坏的不变量：响应丢失后的非幂等操作不能依赖进程内随机 ID 重试；调用方重启后必须能重用持久 operation receipt。
- 触发交错：Relay 或 daemon 已提交写入，但所有响应在客户端收到前丢失；happy-agent 退出。用户重跑相同命令时生成新的 mutation/command/operation ID，导致再次执行 prompt/tools 或创建第二个 Gateway/session。
- 用户影响：重复执行有副作用的工具、重复消息、重复会话和不可预测的自动化结果。
- 已排除保护：单次进程内的五次 send 重试复用同一 mutation body；resume 会先检查 live/recovering Gateway 和 thread lease，不属于该重复路径。跨进程 send 与 spawn 没有持久 receipt。
- 最小复现：服务端提交后丢弃全部响应并终止客户端，再以相同用户操作重启客户端；断言服务端只存在一个逻辑操作。
- 当前覆盖：覆盖进程内 retry/idempotency，没有覆盖调用方退出后的相同操作重放。
- 最小修复方向：为写操作提供调用方可指定且可持久复用的 operation key/receipt，并让 spawn 透传稳定 `operationId`；明确生命周期、冲突语义和清理策略。
- 实施计划：为 happy-agent 增加按 operation UUID 分文件的本地 receipt store，目录权限为 `0700`、文件权限为 `0600`；只持久化请求 SHA-256、完整加密 mutation、状态和必要的 spawn 结果，不写入明文 prompt。`send`/`spawn` 增加 `--operation-id <uuid>`，未显式提供时自动复用相同请求哈希下唯一的未确认 receipt，否则生成新 UUID；同一 UUID 绑定不同操作或请求哈希时显式失败。send 在首次网络发布前持久化 command/mutation 的完整密文，跨进程重试复用相同 command/mutation/producer ID 与密文；spawn 将稳定 `operationId` 透传 daemon，并在输出前缓存成功 sessionId。daemon 在 Gateway 状态目录按 operation UUID 获取跨进程租约，在同一临界区内重新查找 descriptor、创建/恢复 Gateway 并重放 `/root/open`；未知控制响应不取消 root 或停止 Gateway，保留 descriptor/journal 供同 ID 恢复。用户可见成功输出后再把 receipt 标记为已确认；未确认 receipt 永不机会式清理，已确认 receipt 保留 7 天。补充丢失全部响应后新进程重放、并发 spawn 单实例、同 ID 内容冲突、spawn operationId 透传/结果缓存、权限与清理测试，更新 CLI help/smoke，并将 happy-agent 升级到 `0.1.8`、happy-cli 升级到 `1.4.41`。
- 解决证据：待填写。

## F-03 Gateway handoff 失败会留下目标 generation 的 current 元数据

- 状态：待修复
- 严重度：P1
- 置信度：高
- 生产链：`packages/happy-cli/src/codex/gateway/codexGatewayCoordinator.ts:360 performHandoff` -> `packages/happy-cli/src/codex/gateway/codexGatewaySyncRuntime.ts:106 updateBinding` -> metadata durable write -> mapper state/flush -> transport flush -> coordinator catch rollback。
- 被破坏的不变量：handoff 只能原子提交新的 current root；失败回滚后，持久元数据、coordinator 绑定和存活 runtime 必须指向同一 generation。
- 触发交错：目标 runtime 的 metadata 写入成功，随后 mapper 或 transport flush 失败。coordinator 恢复 source 并关闭 target，但没有补偿已经持久化的 target `current` 元数据。
- 用户影响：App/恢复逻辑观察到不存在的 current generation，命令可能路由错误、会话显示漂移，重启后状态难以对账。
- 已排除保护：coordinator catch 会恢复 source、关闭 target、释放 reservation；现有测试的 target fake 在任何持久副作用前失败。Sync runtime 的阶段失败测试能留下 metadata，但未验证跨组件补偿。
- 最小复现：让 target `updateBinding` 完成 metadata write 后在 mapper flush 抛错；断言最终 durable metadata 恢复 source current 且 target 不再 current。
- 当前覆盖：分别覆盖 coordinator 早期失败和 runtime 阶段失败，未覆盖两者组合后的 durable rollback。
- 最小修复方向：把 binding 更新设计为可补偿阶段，handoff 失败时显式恢复 source/target durable metadata，并在补偿失败时进入可对账的 unknown/recovery 状态。
- 实施计划：待真实性复核后填写。
- 解决证据：待填写。

## F-04 App snapshot 替换会覆盖并发发布的本地乐观投影

- 状态：待修复
- 严重度：P2
- 置信度：高
- 生产链：`packages/happy-app/sources/sync/syncV4Client.ts:865 rebuildFromSnapshot` -> `:1058 getPendingOutbox` -> snapshot decrypt -> `:1101 replaceSnapshotForGeneration`；并发链为 `:484 publishEntities` -> `:525 persist outbox` -> `:540 optimistic projection`。
- 被破坏的不变量：本地写入持久化后，snapshot 替换必须重放替换提交时仍未 ACK 的全部 outbox，不能只使用较早捕获的集合。
- 触发交错：snapshot 捕获 pending A 后进入异步解密；本地发布 B 并完成持久化和乐观投影；snapshot 随后全量替换 projection，只重放 A。B 仍在 durable outbox，但从当前 UI projection 消失，直到后续 ACK/pull 才可能恢复。
- 用户影响：刚发送的消息或队列编辑瞬间消失、UI 回退，离线或网络异常时可长时间不可见。
- 已排除保护：publish 与 receive 使用不同锁；outbox 持久化先于投影；generation guard 只阻止旧 client，不能阻止同 generation 并发 publish。
- 最小复现：在 snapshot pending capture 与 replace 之间发布 B，断言替换后 projection 同时包含 A 和 B。审计期 `/tmp` harness 已复现 `pendingOutbox=2` 但 projection 仅含 A。
- 当前覆盖：App sync v4 单测覆盖 snapshot/outbox 重放和 generation fencing，未覆盖同 generation 并发 publish。
- 最小修复方向：在一致的锁/提交边界内重新读取 pending outbox，或让 snapshot replace 与 publish 串行化，同时保持网络和解密工作不长期占用发布锁。
- 实施计划：待真实性复核后填写。
- 解决证据：待填写。

## P-01 App 为全部 Codex 会话启动固定 5 秒轮询

- 状态：待修复
- 严重度：P2
- 置信度：高
- 生产链：`packages/happy-server/sources/app/api/routes/sessionRoutes.ts:87 list sessions`（最多 150、无 lifecycle 过滤）-> `packages/happy-app/sources/sync/sync.ts:845 fetchSessions` -> `:2206 reconcileCodexV4Clients` -> `packages/happy-app/sources/sync/codexV4ClientRegistry.ts:34 eligibility` -> `packages/happy-app/sources/sync/syncV4Client.ts:255 setInterval(5000)`。
- 成本模型：150 个历史/归档 Codex session 会稳定产生约 30 req/s。Relay 空 changes 路径仍进入 Serializable 事务并执行 session/min/page 查询，量级至少约 90 DB 操作/s，单前台 App 每日约 778 万次 DB 操作。
- 用户影响：历史会话数量增长后造成持续客户端耗电、网络占用和 Relay 数据库负载，且与用户是否查看会话无关。
- 已排除保护：registry 只检查 flavor/version；没有 active、selected、recent、archived 或可恢复状态预算。
- 最小复现：构造 150 个合格但 inactive/archived session，运行前台 App，统计 60 秒 changes 请求数及 Relay 查询数。
- 当前覆盖：registry 测试验证创建/移除 client，没有轮询预算或生命周期过滤断言。
- 最小修复方向：定义有限的活跃同步集合和按需唤醒策略；inactive/archived session 通过选中、可见、Socket.IO 提示或低频刷新激活，而不是每个 session 固定轮询。
- 实施计划：待真实性复核后填写。
- 解决证据：待填写。

## P-02 Relay mutation 在 Serializable 事务内逐条执行 ORM 写入

- 状态：待修复
- 严重度：P2
- 置信度：高
- 生产链：`packages/happy-server/sources/app/api/routes/v4SessionRoutes.ts:394 POST mutations` -> `classifySyncV4Mutations` -> session sequence update -> per-mutation entity upsert + journal create；事务由 `packages/happy-server/sources/utils/inTx.ts:17` 以 Serializable、10 秒 timeout、最多三次重试执行。
- 成本模型：100 条全部接受的 mutation 单请求约产生 204 次 ORM 操作，并长期占用单 session Serializable 热点；冲突时整个事务重放，放大数据库工作。
- 用户影响：长时间离线后的批量 flush、多 Gateway 同 session 写入时延迟陡增，可能触发 10 秒超时和 P2034 重试耗尽。
- 已排除保护：请求批次上限为 100，分类会跳过重复/拒绝项，但接受项仍逐条写 entity 和 journal；重试只处理冲突，不降低事务工作量。
- 最小复现：100 条接受 mutation，记录 SQL/ORM 调用数、事务时间和两个并发 writer 的重试率。
- 当前覆盖：路由测试验证语义和幂等结果，不限制批量 ORM 调用数或冲突成本。
- 最小修复方向：在保持 entity/journal/seq 原子性的前提下批量写入，或重新设计单 session sequence 分配，减少事务往返和冲突窗口。
- 实施计划：待真实性复核后填写。
- 解决证据：待填写。

## P-03 happy-agent 等待循环每秒重新拉取完整 snapshot

- 状态：待修复
- 严重度：P3
- 置信度：高
- 生产链：`packages/happy-agent/src/session.ts:293 waitForCommand` / `:309 waitForIdle` -> `:209 readSnapshot`，每页 100 条并以 1 秒间隔重复。
- 成本模型：等待 W 秒、session 有 E 个实体时产生 `O(W * ceil(E/100))` HTTP 请求和 `O(W * E)` 解密/解析。10,000 个实体时每秒约 100 个 snapshot 分页请求。
- 用户影响：长会话上的 wait/stop 造成 Relay 请求突发、客户端 CPU/网络放大，并与 P-01 的固定轮询叠加。
- 已排除保护：snapshot 有固定 high watermark 和分页边界，但等待循环没有增量 cursor，也没有只查询 command/runtime 的窄接口。
- 最小复现：构造 10,000 entity session，等待 10 秒并统计 snapshot 请求数、传输字节和解析时间。
- 当前覆盖：小型 snapshot 单测验证结果，不覆盖实体规模相关请求复杂度。
- 最小修复方向：等待时改用增量 changes/cursor 或 Relay 提供的窄状态查询，并保留 polling 作为持久收敛机制；不得把 Socket.IO 提示当真值。
- 实施计划：待真实性复核后填写。
- 解决证据：待填写。

## 审计验证基线

审计阶段在未修改源码的基线提交上完成以下 source-only 验证：

- App `syncV4Client`：38 tests passed。
- CLI Gateway coordinator/runtime：35 tests passed。
- happy-agent session：8 tests passed。
- Relay v4 routes：28 tests passed。
- 合计：5 个测试文件，109 tests passed。

审计阶段没有运行本地 package/release build、Cargo/Tauri、Android、Docker、真实 PTY 或官方 Codex source build，也没有触发云端工作流。每个修复项必须重新记录与其风险相称的本地和云端证据。

## 解决记录

按完成顺序追加；不得用计划中的命令代替实际结果。

| 编号 | 合并提交 | PR | GitHub CI | 本地验证 | 完成日期 |
| --- | --- | --- | --- | --- | --- |
| F-01 | `659e9058`、`e2cd9788` | #3、#4 | `30972788354`、`30972790180`：34/34；发布 `30973559091`：成功 | happy-agent 10 files / 178 tests；`tsc --noEmit` | 2026-08-05 |
