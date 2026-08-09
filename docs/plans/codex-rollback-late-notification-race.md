# Codex rollback 后迟到通知重激活修复计划

## 状态

- 当前状态：进行中
- 进度说明：`1.4.48` 已合并且 Monorepo CI/CLI release 成功，但 Android Field `31313964459` 证明 rollback provider 已成功后仍生成失败控制卡；`1.4.49` 已完成本地协调恢复与 schema 15 诊断实现，当前补齐通知 orphan 持久化失败的 fatal barrier 语义，必须由新 Field 重新验收。
- 建立日期：2026-08-09。
- 实施分支：`fix/codex-v4-rollback-coordination`。
- 当前基线：`origin/main@a4045c2f81a21c77e6713bc30446620e7974c4eb`。
- 失败版本：`packages/happy-cli` `1.4.48`，不得复用。
- 目标版本：`packages/happy-cli` `1.4.49`；App、Wire、Server 和 happy-agent 不提升版本。
- 提交策略：实现、测试、文档和版本变更完成后一次性提交；云端验收完成后另做 docs-only 归档提交。

## 用户可见故障

用户在 App 内发送 `/clear` 后，官方 Codex 已完成 rollback，旧 turn 也已不再运行；但 App 仍可能永久显示“思考中”，旧 MCP 卡片继续转圈和计时。退出会话或重启 App 不一定恢复，随后发送普通消息还可能因为陈旧 runtime 被投递为排队命令。

该故障不是 provider 长时间执行。现场记录显示 rollback 已返回权威 idle snapshot；错误来自 rollback 周围的迟到通知在 Happy Sync v4 投影中重新制造了活动 turn。

## 根因与竞态窗口

### token usage 具有错误的生命周期副作用

原 `applyTokenUsage()` 对任何 `(threadId, turnId)` 都调用 `ensureTurn()`。当迟到的 `thread/tokenUsage/updated` 引用了 mapper 未知的旧 turn 时，`ensureTurn()` 会：

1. 合成一个 `status=inProgress` 的 `codex.turn`；
2. 把该 turn 写入 `activeTurnByThread`；
3. 在没有 `turn/started`、item lifecycle 或权威 snapshot 证据时制造活动状态。

usage 本来只是统计信息，却因此变成了执行生命周期证据。

### metadata 可以放大合成状态

随后迟到的 `thread/started` metadata 若携带旧 `inProgress` turn，会把上述合成 turn 当作 live active evidence，再将 thread/runtime 提升为 active。即使第一次 metadata 没有改变 idle，只要它先把未知 turn 导入 mapper，第二次相同 metadata 也可能完成重激活。

### rollback response 与 provider 通知没有共同的上游全序

Gateway 的 provider 通知由 Coordinator `notificationPipeline` 串行；App command 则由独立的 command processor 执行。rollback RPC 返回并不表示此前已经从 provider socket 到达的 usage/metadata 已经进入 Router 的 per-thread 队列。

另外，因路由未就绪或投影失败而持久化的 orphan 通知可能仍排在 Router journal 中。若先导入 rollback snapshot、再重放旧 orphan，commandResult 即使已经写成 succeeded，旧通知仍能污染最终投影。

### `1.4.48` Field 暴露了 barrier 的错误职责

合并后的 Android Field run `31313964459` 提供了以下同时成立的证据：

- 官方 app-server 收到了 `thread/rollback`，随后普通 post-clear prompt 也成功完成；
- 最终 runtime 为 connected/idle，且没有 active turn；
- rollback 的 `codex.commandResult` 却不是 `succeeded`，App 因而保留 `Codex control / thread.rollback` 失败卡；
- 旧 schema 14 只保存 `rollbackCommandSucceeded=false`，无法区分 `failed`、`resultUnknown`、`notReplayed` 或 `cancelled`。

Coordinator 在通知路由失败后已经调用 Router；Router 会把可规范化通知写入 durable orphan journal 并安排恢复。只有 orphan 已成功落盘时，`awaitNotificationBarrier()` 才应把该错误视为可恢复；orphan 持久化失败、不可规范化通知或其他没有 durable 副本的错误必须拒绝 barrier。barrier 的职责仍是在调用瞬间冻结并等待 provider notification prefix，而不是把已经具备恢复副本的路由异常再次放大成 rollback RPC 的不确定结果。旧实现把同一恢复链上的异常重复放大：

```text
provider rollback 已成功并返回权威 snapshot
  -> 先前通知的 Router 投影失败，通知已进入 orphan 恢复
  -> Coordinator barrier 再次抛出同一失败
  -> RuntimeFactory 丢弃仍在内存中的 rollback snapshot
  -> commandResult=resultUnknown，随后 reconcile 变成 notReplayed
  -> App 永久显示失败控制卡，即使最终 runtime 已经 idle
```

本轮将 barrier 收敛为纯顺序栅栏，并只重试 barrier 完成后的可幂等本地协调。barrier 对 captured prefix 只等待一次：一旦拒绝就没有完整的 durable 顺序证据，必须直接写 `resultUnknown`；它成功后才最多重试 Router orphan replay、snapshot reconcile 与 mapper flush。重试绝不再次调用 `thread/rollback`，provider outcome/snapshot 始终保留在当前 command execution 中。

## 修复目标

1. 未知 turn 的 token usage 只能更新 thread aggregate usage，不得创建 turn、设置 active map 或触发 turn-state callback。
2. 已知 turn 的 token usage 只能更新 `turn.usage`，不得改变 status、completedAt、thread/runtime 或 active map。
3. 已水合且非活动的 thread 不得从 `thread/started` metadata 导入未知 `inProgress` turn；重复 metadata 也必须保持 idle/systemError。
4. `notLoaded` placeholder 的首次 metadata 仍可正常水合，真实 `turn/started`、plan、diff、item 和 delta 的既有乱序容错不回归。
5. rollback provider response 返回后，先等待当时已入队的 Coordinator notification prefix，再进入 outcome route coordination。
6. Router 在同一 thread pipeline 内先回放并完成该 thread 的 persisted orphan，再导入 rollback snapshot 并 flush。
7. Coordinator 只吞掉已成功写入 durable orphan 的路由失败并交给 Router 恢复；orphan 持久化失败或没有 durable 副本的失败必须拒绝 barrier，rollback 直接写 `resultUnknown`。其余可重试的本地协调最多尝试三次，只有三次均失败才写 `resultUnknown`。
8. rollback 后无论迟到 usage/metadata 到达一次还是重复到达，App 最终仍为 connected/idle、无 `inProgress` turn，旧历史 part 保留且 final。
9. Android Field 必须证明 post-clear 精确文本对应的 command 与同 commandId 的 succeeded result，不能再用 command 总数代替关联证据。
10. Android Field daemon 必须由本次源码打包并隔离安装后的 npm CLI 启动，不能直接运行仓库 `dist/index.mjs`。

## 明确非目标

- 不从 elapsed time、socket 断开、RPC timeout、interrupt ACK 或 command ACK 推断 turn 完成。
- 不限制官方 `thread/status/changed` 生命周期通知。
- 不全局移除 `ensureTurn()` 的 active-map 副作用；plan、diff、item 和 delta 的早到容错仍依赖它。
- 不新增 pending usage cache、Wire 字段、provider epoch、时间戳比较或超时清理。
- 不删除 `/clear` 前的 turn/item/part 历史，不把 rollback snapshot写入网络 commandResult payload。
- 不修改 App 运行时代码或 Sync v4 Wire schema，因此不提升 App/Wire/Server/Agent 版本。
- 不在本地构建 CLI archive、Android APK、官方 Codex、Tauri/Rust、Web 或其他发布制品。

## 实施步骤

### 1. Mapper 生命周期隔离

- `applyTokenUsage()` 先规范化并发布 thread aggregate usage。
- 使用现有 `turnKey(threadId, turnId)` 只读查找 turn；不存在时立即返回。
- 只有已存在 turn 才更新其 `usage=tokenUsage.last`，保持所有生命周期字段原值。
- `applyThreadSnapshot(..., source='metadata')` 区分：
  - 无 previous 或 previous=`notLoaded`：允许首次 snapshot 水合；
  - 已水合 active 且已有 live active map：保留当前活动 turn；
  - 已水合 idle/systemError：跳过不等于 live active turn 的 `inProgress` snapshot turn；
  - completed/interrupted/failed snapshot turn 仍可正常 upsert。
- 保留 systemError 保护和真实 `turn/started` 的活动语义。

### 2. Coordinator notification barrier 与本地协调恢复

- 方法调用时捕获当前 `notificationPipeline` promise，不动态追赶调用后才入队的通知。
- 通知路由失败继续调用 payload-free `onError`，但 catch 必须自身兑现；已成功 orphan 的失败不记入 barrier，未成功 orphan 的失败记录为当前 prefix 的 fatal barrier。即使诊断 sink 抛错，也不得毒化后续串行通知。
- RuntimeFactory 仅在 `thread.rollback` 的 provider outcome 返回后、注册 route outcome 前等待 barrier。
- 对同一个 provider outcome 只等待一次 barrier；barrier 成功后在本地依次尝试最多三次 Router reconciliation，不重新进入 `commandExecutor.execute()`。
- 三次覆盖 mapper 的错误 latch：第一次可能观察已持久化 orphan 的原始路由/快照失败，第二次恢复 orphan 并消费已经被记录的 mapper error，第三次完成重放与权威 snapshot flush；任何 fatal barrier 都不进入本地重试。
- 任一次完整本地协调成功即写 `succeeded`；三次仍失败才包装为 `CodexRpcOutcomeUnknownError`。

严格顺序为：

```text
provider rollback response（只执行一次）
  -> capture and await notification pipeline prefix exactly once
  -> barrier rejected: command resultUnknown
  -> barrier fulfilled: [attempt 1..3] Router orphan replay + rollback snapshot + flush
      -> first successful local attempt: command succeeded
      -> all attempts failed: command resultUnknown
```

### 3. Router orphan 与 snapshot 排序

- `reconcileRollbackSnapshot(threadId, snapshot)` 继续使用现有 per-thread pipeline。
- 取得 owned binding 后检查该 thread 的 persisted orphan。
- 若存在 orphan，先按 journal 顺序 route、mapper flush、complete orphan。
- orphan 全部完成后才调用 `mapper.reconcileRollbackSnapshot(snapshot)`。
- snapshot reconcile 后再次 `mapper.flush()`，再返回 command processor。
- orphan replay 失败时保留 orphan，跳过 snapshot；snapshot/flush 失败时向上抛出，最终 command 为 `resultUnknown`。

### 4. 确定性回归测试

Mapper 单测覆盖：

- unknown usage 更新 aggregate，但 `codex.turn` 为空、activeTurnId 为 null、runtime 不变；
- completed turn 的 late usage 保持 completed/idle；
- usage 先建立 `notLoaded` placeholder 后，首次合法 metadata 仍可水合；
- idle thread 收到 unknown usage 和两次 stale metadata 后仍 idle，无 phantom turn；
- rollback 历史 turn/item/part 保持 interrupted/final，late usage 只更新 usage；
- active metadata 保护和 systemError active-map 清理不回归。

Gateway/Router 单测覆盖：

- barrier 只等待调用时已存在的 provider notification prefix；
- 已持久化 orphan 的路由失败和抛错的诊断 sink 都不能让 barrier/后续通知队列失败；
- 已持久化 orphan 的路由失败不拒绝 barrier；orphan 持久化失败拒绝当前 barrier，且后续通知仍按序执行；
- barrier 截断前缀后才入队的 fatal 通知只影响下一批，不能回写为前一 barrier 的失败；
- command 保持 executing，直到 barrier、snapshot persist 全部完成；
- snapshot 首次持久化失败可由后续本地协调恢复，provider RPC 恰好调用一次；
- 任意 barrier 拒绝（即使后续调用本可成功）都立即写 `resultUnknown`，不伪造 succeeded；
- 三次本地协调持续失败才写 `resultUnknown`，不伪造 succeeded；
- persisted orphan 的顺序为 notification -> orphan flush -> rollback snapshot -> snapshot flush；
- orphan replay 失败不应用 snapshot且 orphan 保留。

### 5. HTTP relay 真实链路

在现有真实 relay + CLI mapper/router + App projection 场景中：

1. 导入一条含历史 agent part 的活动 rollback turn。
2. fake app-server 在 rollback response 前发送 usage 和 stale metadata。
3. response 返回权威 empty/idle thread。
4. response 后再次发送同一 usage 和 metadata。
5. 等待四条通知全部到达并 flush 到真实 HTTP relay。
6. App 拉取后断言 runtime idle、active turn 为 null、turn/item interrupted、历史 part 内容保留且 final。

### 6. Android Field 严格验收与失败取证

- 诊断 schema `14 -> 15`。
- 对目标 thread 选择 `updatedAt` 最新的 `thread.rollback`，相同时间以 commandId 稳定决胜。
- 仅接受同 commandId 且同 threadId 的 result；记录 `rollbackCommandId`、有限枚举 terminal status、`updatedAt` 和白名单 `errorKind`。
- `errorKind` 只能是 `none|commandMissing|resultMissing|resultThreadMismatch|resultNonTerminal|failed|resultUnknown|notReplayed|cancelled`，禁止读取或输出 command payload、result、error 文本、providerRequestId。
- 固定 post-clear 输入常量 `post-clear-from-android-e2e`，Responses fixture 与 Field fixture 共用。
- 解密最终 snapshot 后，仅接受：
  - 同 target thread；
  - command 为 `turn.start`、`turn.queue` 或 `turn.steer`；
  - payload `text` 精确等于 post-clear 输入；
  - 存在同 commandId 的 `codex.commandResult.status=succeeded`。
- 对错误 thread、错误 text、不匹配 commandId、executing/failed result 和 rollback command 增加负向单测。
- Workflow 先 build，再 `pnpm pack` 生成 tgz；用 `npm install --ignore-scripts --prefix` 隔离安装并校验 `happy --version`。
- 通过 `HAPPY_MOBILE_E2E_CLI_ENTRYPOINT` 把安装版 launcher 交给 fixture，daemon 从该 launcher 启动。
- shell gate 同时要求 diagnostics 与 verification JSON 中 `postClearCommandSucceeded=true`。
- shell gate 要求 rollback terminal status=`succeeded`、errorKind=`none`，并校验 diagnostics/verification 四个关联字段完全相同；失败 trap 打印不含 payload 的状态摘要。

### 7. `1.4.49` 版本、提交与发布

- `packages/happy-cli/package.json` 从已经发布过的 `1.4.48` 升到 `1.4.49`。
- 运行文档生成和检查；确认仅 CLI 版本变化。
- 完成差异审查和本地源码验证后，使用短中文提交说明本地协调修复。
- push 到 `origin`，创建 PR，等待 Required CI、CLI Smoke 和 Documentation。
- 合并后以精确 merge SHA 等待 Monorepo CI、CLI release、Android Field。
- 工作流卡住时先读取 job 证据，再取消并对同 SHA 重试一次；不无限等待。
- 一旦 `1.4.49` release workflow 已运行，若还需源码修复，必须升 `1.4.50`，不得复用版本。
- CLI workflow 成功后下载 `happy-1.4.49.tgz` 到 `dist/release-artifacts`，校验 SHA-256、package version 和 macOS ARM64 工具归档。
- 只有 Monorepo CI、CLI release 与 Android Field 对同一 merge SHA 全部成功后，才安装 tgz 并重启 daemon 与目标 Gateway worker。
- 现场复验原会话的 `/clear -> 普通 prompt`；确认无失败控制卡、runtime idle、旧 MCP/turn 终态且新消息正常回复。
- 所有交付完成后把本计划状态改为已完成并移入 `docs/plans/archive/`，提交 docs-only 收尾。

## 验证矩阵

### 本地源码验证

```bash
node ../../node_modules/vitest/vitest.mjs run --project unit \
  src/codex/codexSyncV4Mapper.test.ts \
  src/codex/codexV4ThreadRouter.test.ts \
  src/codex/gateway/codexGatewayCoordinator.test.ts \
  src/codex/gateway/codexGatewayRuntimeFactory.test.ts
node node_modules/vitest/vitest.mjs run \
  scripts/ci/codex-responses-fixture.test.ts \
  scripts/ci/codex-mobile-field-command-correlation.test.ts
node_modules/.bin/tsc --noEmit -p scripts/ci/tsconfig.codex-official.json
node_modules/.bin/tsc --noEmit -p packages/happy-cli/tsconfig.json
node ../../node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json \
  ../../scripts/ci/codex-http-relay-scenario.ts
bash -n scripts/ci/run-codex-android-field-e2e.sh
pnpm docs:sync
pnpm docs:check
git diff --check
```

### 云端验收

- PR Required CI 和 CLI Smoke 针对同一 PR head 成功。
- 合并后的 Monorepo CI 必须包含 fake-provider transport、mapper、relay ordering 和 App projection recovery。
- CLI release 必须针对精确 merge SHA 生成版本 `1.4.49` 的唯一 tgz。
- Android Field 必须使用 source-built official Codex、已安装 APK 和已安装 tgz CLI，并输出 schema 15 的 verified diagnostics。
- 最终 snapshot 必须证明 runtime connected/idle、statusKnown、无 pending request、无 `inProgress` turn、rollback command succeeded、post-clear command/result 精确关联成功。

## 完成条件

- [x] mapper 不再从 unknown usage 合成活动 turn。
- [x] stale metadata 重复到达仍不能重激活 idle/systemError。
- [x] Coordinator barrier 与 Router orphan-before-snapshot 顺序已实现。
- [x] 定向 mapper/Gateway/Router 测试已通过。
- [x] HTTP relay rollback 前后迟到通知场景已通过。
- [x] Field schema 14、post-clear 命令关联与安装包 CLI workflow 已实现并通过源码测试。
- [x] `1.4.48` 已合并，Monorepo CI 与 CLI release 成功。
- [x] Android Field `31313964459` 的 rollback command 失败已被确认为当前阻断项。
- [x] barrier 纯顺序语义、三次本地协调、orphan 持久化失败的 fatal 语义和 schema 15 精确终态诊断完成本地验证与差异审查。
- [ ] `1.4.49` 提交、PR、合并及精确 SHA 云端验收完成。
- [ ] `happy-1.4.49.tgz` 已下载、校验、安装，本机 daemon/worker 与原会话复验完成。
- [ ] 计划已归档并完成 docs-only 收尾提交。
