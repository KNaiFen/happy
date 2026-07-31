# Happy Codex Sync v4 R3-4 差异审查

## 结论

**CONDITIONAL**

R3-4 的 CLI Gateway 方向与整改计划一致：Codex stable-v2 通知按真实
thread 路由，provider child 使用独立只读 side session，未知 thread 不再
猜测为 root，orphan、route、provider request 和 command coordination 均有
持久恢复边界，raw reasoning text 不进入 Sync v4。

本次审查发现的 R3-4 correctness/security 阻断项均已修复并增加回归测试。
但整个 Sync v4 仍须保持关闭，直至 R4 App 持久投影、R5 HTTP 平台约束和
R6 业务链路、Chaos、规模及全面 CI 门禁全部完成。

## 审查范围

- 基线：`57956fd4`
- 范围：基线至当前工作区的 CLI R3-4 变更
- 重点文件：
  - `packages/happy-cli/src/api/syncV4Client.ts`
  - `packages/happy-cli/src/api/syncV4Crypto.ts`
  - `packages/happy-cli/src/api/syncV4Journal.ts`
  - `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`
  - `packages/happy-cli/src/codex/codexV4ThreadRouter.ts`
  - `packages/happy-cli/src/codex/codexV4CommandRouting.ts`
  - `packages/happy-cli/src/codex/runCodex.ts`
  - `packages/happy-cli/src/utils/setupOfflineReconnection.ts`
- 协议基准：Codex CLI `0.145.0` stable-v2；`experimentalApi=false`
- 威胁边界：relay 不可信但只见密文；Codex app-server 是本地 provider
  进程；HTTP 模式不抵抗主动 MITM。

## 已修复发现

### HIGH-01：bound notification 失败后 live 流可越过 durable orphan

原实现只保证 orphan 记录内部 FIFO。某条已绑定通知投影失败后，后续 live
通知仍可直接投影，重放后会形成 `completed -> started` 或 `idle -> active`
倒序，重新制造思考状态和 child relation 假结束。

修复：Router 为存在 pending orphan 的 thread 建立统一队列门禁；后续
canonical live notification 必须先追加到同一持久 FIFO，再按序投影。

验证：新增连续通知中首条投影失败的回归测试，最终 mapper 顺序严格保持
原始到达顺序。

### HIGH-02：spawn route 无初始状态导致重启漏恢复 child

父线程 `spawnAgent` item 已登记 lineage、child 首个通知尚未到达时，route
没有 `status`。CLI 在该边界重启后只恢复 `starting/active` route，因此可能
跳过后台仍运行的 child。

修复：首次 provider-child/detached-review lineage route 持久化为
`starting`、`activeTurnId=null`；即使没有 orphan，重启也主动
`thread/read` 并恢复 binding。

验证：新增“parent spawn 已提交、无 child orphan、随后重启”的恢复测试。

### HIGH-03：App command 的 canonical target 与 payload target 可分叉

ownership 使用 `command.threadId`，部分 RPC 过去优先使用
`payload.threadId`。恶意或损坏命令可以通过不同目标绕过会话归属判断。

修复：统一目标解析；两者同时存在时必须相等，ownership 和实际 RPC 使用
同一 canonical target。

### HIGH-04：provider RPC 成功但 route coordination 失败被误报 failed

thread start/resume/fork/review RPC 成功后，如果 route 或 metadata 持久化
失败，原路径可能发布普通失败结果，诱导重试非幂等调用。

修复：route 保存 `coordinatedCommandId` receipt；协调结果不明进入
`resultUnknown`，重启先查 receipt，未确认时绝不自动重放。

### HIGH-05：JSON-RPC 响应与紧随 request 的同 chunk 登记竞态

Node readline 会同步派发同一 stdout chunk 中的多行；RPC Promise 续体尚未
登记 root/review route 时，紧随响应的 provider request 会被误判为未知
thread。

修复：只对等待权威 route 的 request 做有界登记等待；route fsync 后立即
唤醒，超时仍返回协议错误，不猜 root。

### HIGH-06：出站 entity 仅依赖 TypeScript 静态类型

无效或超过 64 KiB UTF-8 上限的 provider entity 可先计算 opaque ID，之后
才在远端消费侧失败，存在坏 mutation 阻塞 App cursor 的风险。

修复：所有 Sync v4 publish 入口先运行 Wire canonical schema；加密层再次
校验。ID、AAD、序列化和 journal 全部使用 canonical entity。

验证：crypto 与 client 两层测试覆盖缺字段和超界 part，确认不会产生
transport batch。

### MEDIUM-01：root binding 在 route map 为空时漏 connection/flush

初次 thread 尚未创建时，`allBindings()` 过去可能为空，导致断连状态、
pending request 失败和 flush 不传播。

修复：root binding 永远包含在 binding 集合中，与 route 是否存在无关。

### MEDIUM-02：route 恢复未清除空 active turn

持久 route 的 `activeTurnId=null` 过去不会删除旧内存值，迟到 completion
可能错误影响新的 relation 状态。

修复：restore 对空值显式删除 active-turn map。

### MEDIUM-03：raw reasoning 可能经 orphan snapshot 对象展开落盘

reasoning delta 已被忽略，但 completed/snapshot item 若直接展开，未来字段
可能重新携带 raw reasoning。

修复：reasoning journal payload 按 stable-v2 白名单重建，只保留
`type`、`id`、summary，并强制 `content=[]`。

### MEDIUM-04：child MCP 查询可回退到全局 selected thread

child 对不带 target 的 `mcp.status.list` 虽然不写 provider 状态，但 RPC 会
使用 app-server 当前 selected thread，造成主/子线程状态串读。

修复：child 的 thread-scoped 只读查询必须显式命中 owned child；真正全局的
skills/model 查询仍可无 thread。

## 架构一致性

- `thread/read(includeTurns=true)` 是唯一 stable 历史入口；没有使用
  experimental turns/items 分页。
- `turn/interrupt` 的 RPC ACK 不作为终态；只由权威 snapshot/status 或
  `turn/completed` 收敛。
- `/compact` 继续映射 `thread/compact/start`，最终状态依赖
  `contextCompaction` item。
- provider child、user fork、detached review 和 sibling communication
  使用独立分类；只有 `spawnAgent` 建立 provider child lineage。
- child command 边界仅允许只读查询，拒绝 turn、审批、用户输入和
  `request.resolve` 状态改变。
- raw reasoning 只保留本地计数；日志只写散列 ID、方法名和有界状态。
- Socket/relay invalidation 不参与本切片正确性，实体先进入 durable outbox。

## 非阻断残余风险

以下项目不允许在最终发布时遗留，但归属已落盘的后续门禁：

1. orphan backlog 和单 thread pipeline 尚无规模压测证明；R6 必须注入持续
   未知 thread、投影失败和大 delta，验证磁盘增长、事件循环让步与恢复时间。
2. stream flush 随 chunk 数增长会扫描已发布 chunk；R6 的 10,000 entity、
   5 Hz delta 和 p95 门禁必须验证，超标时改为 dirty-tail 索引。
3. App 侧 shadow snapshot、坏索引重建、revision 分类、child 双层只读尚属
   R4，当前不能宣称端到端恢复完成。
4. HTTP 原生平台显式确认、Web HTTPS/localhost 限制和移动端/Tauri 配置尚属
   R5，当前不能启用非安全 relay 模式。
5. 100,000 mutation Chaos、真实长 turn、完整业务链路和全面 GitHub CI 尚属
   R6，feature flag 必须保持关闭。

## 发布判定

R3-4 可在完整 CLI 门禁和云端 CLI/PR/Smoke 检查通过后作为独立提交合入当前
重构分支；不得因此启用 Sync v4。最终发布判定已按
`docs/plans/archive/codex-sync-v4-remediation-r12.md` 的完成定义执行，并于
2026-08-01 通过同一提交的完整云端门禁。

本地门禁结果：CLI build/typecheck 通过，`101/101` 测试文件、
`993/993` 单元测试通过；R3-4 定向集合 `10/10` 文件、`127/127` 测试通过。
