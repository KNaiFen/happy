# Codex rollback 后迟到通知重激活修复计划

## 状态

- 当前状态：进行中
- 进度说明：核心实现、CLI 全量 unit/typecheck、HTTP relay、Android Field 源码检查和差异审查已完成，正在进行提交、云端验收与发布交付。
- 建立日期：2026-08-09。
- 实施分支：`fix/codex-v4-mapper-race`。
- 基线：`origin/main@9e7f4b34a1412a868dfe45448e0f5f8b0ad7ce01`。
- 目标版本：`packages/happy-cli` `1.4.48`；App、Wire、Server 和 happy-agent 不提升版本。
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

## 修复目标

1. 未知 turn 的 token usage 只能更新 thread aggregate usage，不得创建 turn、设置 active map 或触发 turn-state callback。
2. 已知 turn 的 token usage 只能更新 `turn.usage`，不得改变 status、completedAt、thread/runtime 或 active map。
3. 已水合且非活动的 thread 不得从 `thread/started` metadata 导入未知 `inProgress` turn；重复 metadata 也必须保持 idle/systemError。
4. `notLoaded` placeholder 的首次 metadata 仍可正常水合，真实 `turn/started`、plan、diff、item 和 delta 的既有乱序容错不回归。
5. rollback provider response 返回后，先等待当时已入队的 Coordinator notification prefix，再进入 outcome route coordination。
6. Router 在同一 thread pipeline 内先回放并完成该 thread 的 persisted orphan，再导入 rollback snapshot 并 flush。
7. barrier、orphan replay、snapshot reconcile 或 flush 任一步失败，都只能写 `resultUnknown`，不得写 succeeded。
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

### 2. Coordinator notification barrier

- 新增 `awaitNotificationBarrier()`。
- 方法调用时捕获当前 `notificationPipeline` promise，不动态追赶调用后才入队的通知。
- RuntimeFactory 仅在 `thread.rollback` 的 provider outcome 返回后、注册 route outcome 前等待该 barrier。
- barrier 位于 route coordination 的 unknown-outcome 包装范围内；失败转换为 `CodexRpcOutcomeUnknownError`。

严格顺序为：

```text
provider rollback response
  -> capture and await notification pipeline prefix
  -> register rollback outcome
  -> Router per-thread coordination
  -> command terminal transition
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
- command 保持 executing，直到 barrier、snapshot persist 全部完成；
- barrier 失败写 `resultUnknown`，不应用 snapshot；
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

### 6. Android Field 严格验收

- 诊断 schema `13 -> 14`。
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

### 7. 版本、提交与发布

- `packages/happy-cli/package.json` 从 `1.4.47` 升到 `1.4.48`。
- 运行文档生成和检查；确认仅 CLI 版本变化。
- 完成差异审查和本地源码验证后，提交：`fix(cli): 修复回滚后迟到通知重激活`。
- push 到 `origin`，创建 PR，等待 Required CI、CLI Smoke 和 Documentation。
- 合并后以精确 merge SHA 等待 Monorepo CI、CLI release、Android Field。
- 工作流卡住时先读取 job 证据，再取消并对同 SHA 重试一次；不无限等待。
- 一旦 `1.4.48` release workflow 已运行，若还需源码修复，必须升 `1.4.49`，不得复用版本。
- CLI workflow 成功后下载 `happy-1.4.48.tgz` 到 `dist/release-artifacts`，校验 SHA-256、package version 和 macOS ARM64 工具归档。
- 安装 tgz、重启 daemon，现场复验原会话的 `/clear -> 普通 prompt`。
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
- CLI release 必须针对精确 merge SHA 生成版本 `1.4.48` 的唯一 tgz。
- Android Field 必须使用 source-built official Codex、已安装 APK 和已安装 tgz CLI，并输出 schema 14 的 verified diagnostics。
- 最终 snapshot 必须证明 runtime connected/idle、statusKnown、无 pending request、无 `inProgress` turn、rollback command succeeded、post-clear command/result 精确关联成功。

## 完成条件

- [x] mapper 不再从 unknown usage 合成活动 turn。
- [x] stale metadata 重复到达仍不能重激活 idle/systemError。
- [x] Coordinator barrier 与 Router orphan-before-snapshot 顺序已实现。
- [x] 定向 mapper/Gateway/Router 测试已通过。
- [x] HTTP relay rollback 前后迟到通知场景已通过。
- [x] Field schema 14、命令关联与安装包 CLI workflow 已实现并通过源码测试。
- [x] CLI 全量 typecheck、文档检查、差异审查完成。
- [ ] 提交、PR、合并及精确 SHA 云端验收完成。
- [ ] `happy-1.4.48.tgz` 已下载、校验、安装，本机 daemon 与原会话复验完成。
- [ ] 计划已归档并完成 docs-only 收尾提交。
