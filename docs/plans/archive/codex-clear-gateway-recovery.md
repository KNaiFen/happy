# Codex `/clear` 状态收敛与 Gateway 临时目录自愈实施计划

## 状态

- 当前状态：已完成。实现、独立审查、PR 与合并后云端验收均已通过；CLI `1.4.47` 已安装到本机，缺失 runtime 目录造成的 Gateway 无限恢复循环已消除，本计划已归档。
- 建立日期：2026-08-09。
- 实施分支：`fix/codex-clear-gateway-recovery`。
- 基线：`origin/main@797ecd501416ffa9230d507c3b3f870b5c366832`。
- 实现提交：`03da36cfe0c045dedb307addf9275d3489c734c1`；PR [#23](https://github.com/KNaiFen/happy/pull/23)；合并 HEAD `3747ee11f0ff4b4eb50efc05c98f9a1d74bed8ac`。
- 目标版本：`packages/happy-cli` `1.4.47`；App、Wire、Server、happy-agent 不提升版本。
- 提交策略：实现、测试、文档和版本变更完成并复核后一次性提交，不拆分中间提交。

## 现场证据与根因

### `/clear` 后 App 长期显示思考中

目标会话中，`turn.interrupt` 和 `thread.rollback` 都已经被官方 Codex app-server 接受。provider rollout 的最后权威事件是 `thread_rolled_back`，回滚十个 turn 后没有新的 `task_started`。因此 App 中继续存在的活动 turn、MCP 转圈和秒数不是 provider 仍在执行，而是 Sync v4 投影没有收敛。

原链路如下：

```text
App /clear
  -> codex.command(thread.rollback, allTurns=true)
  -> thread/read(includeTurns=true)
  -> official thread/rollback
  -> rollback response Thread snapshot
  -> registerThreadSnapshot(..., source=snapshot)
  -> synthetic thread/started notification
  -> mapper treats it as late metadata
  -> previous active/systemError protection keeps old active state
  -> App runtime remains active and old tool item remains running
```

`thread/started` 的迟到保护本身是正确的：真实 metadata 不能把已经观测到的 active 或 systemError 覆盖成 idle。错误在于把 rollback RPC 的权威响应伪装成 metadata，导致权威状态失去语义。

### daemon 每分钟反复恢复四个 Gateway

四个异常 Gateway 的 durable descriptor、secret 和 journal 仍存在，状态为 `recovering`，但 descriptor 指向的 control socket 及其临时父目录已经被系统清理。daemon 每分钟发现 control 不可达，使用同一 Gateway ID 启动 worker；worker 读取持久状态后直接 `listen()`，因为父目录不存在而失败，再次留下 `recovering`。

健康 Gateway 的临时目录仍存在，因此不受影响。原失败只记录为 `startup:control:unknown`，无法从安全诊断区分 `ENOENT`、权限错误或路径类型错误。

## 目标

1. `/clear` 成功后，权威 rollback 快照必须在 commandResult `succeeded` 之前完成 Sync v4 投影与 flush。
2. App 最终必须显示 runtime idle，不能再找到任何 `inProgress` turn；被回滚活动 turn 的工具卡停止转圈和计时。
3. `/clear` 前已经同步的消息、工具项和内容块继续保留在 App 历史中，不因状态修复被删除。
4. 真实迟到 `thread/started` metadata 继续不能覆盖 active 或 systemError。
5. Gateway worker 恢复时自动重建缺失的 runtimeRoot/runtimeDir，并继续使用原 Gateway ID、确定性 socket 路径、descriptor、secret、journal 和 binding。
6. 目录安全语义与新建 Gateway 完全一致：POSIX `0700`、非 symlink、当前 UID 所有；不 `chown`，不接受普通文件或另一用户目录。
7. startup 诊断只持久化固定白名单中的 Node error code，不记录 message、stack、path、syscall、cause 或 provider payload。
8. Android Field 使用官方 source-built Codex app-server 验证 `/clear` 后的新 prompt、idle 状态、无活动 turn 和旧历史保留。

## 非目标与边界

- 不从 elapsed time、socket 断开、RPC timeout、interrupt ACK 或 command ACK 推断 turn 完成。
- 不改变 Sync v4 Wire schema，不新增跨网络的 rollback snapshot 字段。
- 不把 rollback snapshot 写入 `codex.commandResult.result`；它只在 CLI 进程内协调。
- 不改变正常 `thread/started`、resume metadata 或 migration snapshot 的投影语义；仅补强迟到旧快照的单调性：已知为终态的本地 turn 不得被 metadata 重新激活，`systemError` 也不能被 metadata 覆盖。
- 不删除 `/clear` 前的历史 turn/item/part；只收敛仍为运行态的实体。
- 不为无法验证的 provider 失败猜测 idle；RPC 失败时不导入快照。
- 不删除、迁移或重新生成 Gateway descriptor、secret、journal、Gateway ID、socket 路径或 binding。
- 不递归清理健康 Gateway 的 runtimeRoot，也不因恢复失败创建新 Gateway。
- 不在日志中写 prompt、reasoning、tool arguments/output、provider ID、token、key 或本机私有路径。
- 不在本地构建 CLI 制品、Android APK、官方 Codex、Web、Tauri 或 Rust。

## `/clear` 权威协调设计

### RPC 与进程内 outcome

`CodexAppServerClient.rollbackThread()` 仍把 RPC response 注册到本地 `CodexThreadRegistry`，以便本进程的 selected turn 和 pending completion 立即收敛；调用方可传 `emitSnapshot:false`，禁止生成 synthetic `thread/started`。

executor 的 all-turn rollback 采用以下顺序：

```text
readThreadComplete(threadId, emitSnapshot=false)
  -> numTurns = authoritative pre-read turns.length
  -> numTurns == 0:
       return result(rolledBackTurns=0) + rollbackSnapshot
  -> numTurns > 0:
       rollbackThread(threadId, numTurns, emitSnapshot=false)
       return result(rolledBackTurns=numTurns) + rollbackSnapshot
```

即使没有 provider turn，也必须携带读取到的权威快照，借此清除 App/mapper 中可能残留的旧 active 状态。`rollbackSnapshot` 是 `CodexV4CommandOutcome` 的进程内字段；`resultFor()` 只序列化公开的 `result`，因此快照不会进入 commandResult、journal 或网络。

### Router 排序与成功边界

`registerCodexV4CommandOutcome()` 对 `thread.rollback` 执行三重校验：command target、outcome threadId 和 snapshot.id 必须完全相同。然后调用 Router 的 rollback 专用方法。

Router 使用已有 per-thread pipeline：

```text
enqueueThread(threadId)
  -> resolve existing owned binding
  -> mapper.reconcileRollbackSnapshot(snapshot)
  -> mapper.flush()
  -> return to command executor callback
  -> processor publishes commandResult=succeeded
```

notification 与 rollback snapshot 因此在同一 thread 队列内有确定顺序。协调或 flush 失败时，factory 把“provider 已完成、投影结果不确定”转换为 `CodexRpcOutcomeUnknownError`；processor 只能记录 `resultUnknown`，不能误报 succeeded。

### Mapper 收敛规则

专用 rollback reconcile 在 mapper 自身单一 pipeline 中执行：

1. 取得权威 snapshot 中的 turn ID 集合。
2. 查找相同 thread 下本地仍为 `inProgress`、但 snapshot 已不存在的 turn。
3. 将这些 turn 更新为 `interrupted`，补齐 `completedAt` 和 `updatedAt`。
4. 将属于这些 turn 且仍未完成的 item 更新为 `interrupted`，补齐 `completedAt`。
5. 最终化这些 item 的现有 part stream，使工具输出保留但 `final=true`，工具卡不再 running。
6. 清除本地 activeTurn map。
7. 以 `source=snapshot` 导入权威 thread/turn 状态并发布 thread/runtime。
8. 发布最终 `onTurnStateChanged`；Router 随后 flush。

历史 item 和 part 不 tombstone。已经终态的 turn/item 不改写；snapshot 中仍存在的 turn 按 snapshot 正常 upsert。普通 metadata 仍走 `source=metadata` 分支：保持既有 active/systemError 保护，并额外忽略引用已知终态 turn 的迟到 `inProgress` 标记。

## Gateway runtime 目录自愈设计

### 共用安全函数

`codexGatewayState.ts` 导出 `ensureCodexGatewayRuntimeDirectories(paths)`，新建和恢复共用现有 `ensurePrivateDirectory`：

- `mkdir(..., recursive=true, mode=0700)`；
- POSIX 上 `lstat` 后必须是 directory 且不是 symlink；
- 若 `process.getuid()` 可用，目录 UID 必须等于当前 UID；
- 最后强制 `chmod(0700)`；
- Windows 保留现有跳过 POSIX mode/UID 校验的行为。

worker 只有在 descriptor/secret ID 一致、Gateway 非 stopped、provider/TUI endpoint 结构有效后才调用；调用发生在打开 journal 和改写 descriptor 前。目录失败因此记录为 `startup:state:<kind>`，不会留下半初始化 control/provider。

### 保留内容

自愈只创建缺失目录，不执行删除、rename、socket path 替换或状态迁移。恢复后仍使用 descriptor 中的：

- `gatewayId`；
- `providerSocketPath`、`tuiSocketPath`、`controlSocketPath`；
- `current` 和 `draining` binding；
- 原 secret 与 session key seed；
- 原 journal 和 pending bootstrap。

健康 Gateway 的 control status 可达时 launcher 不 spawn worker，因此不会触发目录保障；即使触发，已有安全目录只会被验证并校正 mode。

### 安全错误分类

`safeErrorKind()` 先以防御性 `try/catch` 读取 `error.code`，只接受：

`ENOENT`、`EACCES`、`ENOTDIR`、`EEXIST`、`EPERM`、`EROFS`、`ELOOP`、`ENOSPC`、`EIO`、`EADDRINUSE`。

未命中时继续现有 typed error 与 Sync v4 分类。分类器不得访问或持久化 message、stack、path、syscall、cause；带敏感 marker 的测试必须证明 descriptor 原文不含 marker 或路径。

## Android Field 验收

恢复 flow 保留原有 request recovery、MCP choice、queued follow-up、compact 和历史断言，然后执行：

1. 发送结构化 `/clear`。
2. 紧接着发送唯一文本 `post-clear-from-android-e2e`。
3. Responses fixture 只有精确收到该文本时才返回 `Official Codex post-clear E2E response`。
4. 断言时间线中不出现 `CodexControlCommand` 或 `thread.rollback` 内部卡片。
5. 再次滚动并确认 `resume-history-from-android-e2e` 仍存在。
6. 解密最终 Sync v4 snapshot，要求 selected runtime connected/idle、`statusUnknown=false`，整个快照不存在 `inProgress` turn，所有 request 非 pending。

诊断 schema 从 12 提升到 13，新增五项严格证据：provider post-clear sentinel、provider 未收到 `/clear` prompt、post-clear runtime idle、无 active turn，以及结构化 rollback command succeeded。shell gate 同时检查 diagnostics 与 verification JSON，旧 schema 或缺字段不能通过。

## 实现文件边界

- `packages/happy-cli/src/codex/codexAppServerClient.ts`：rollback registry 更新与 notification 抑制选项。
- `packages/happy-cli/src/codex/codexV4CommandExecutor.ts`：无通知预读、zero-turn snapshot、进程内 outcome。
- `packages/happy-cli/src/codex/codexV4CommandProcessor.ts`：仅进程内 snapshot 类型，不改变持久结果 schema。
- `packages/happy-cli/src/codex/codexV4CommandRouting.ts`：target/snapshot 校验与 Router 协调。
- `packages/happy-cli/src/codex/codexV4ThreadRouter.ts`：per-thread rollback reconcile 和 flush。
- `packages/happy-cli/src/codex/codexSyncV4Mapper.ts`：turn/item/part 终态化与权威 runtime 投影。
- `packages/happy-cli/src/codex/gateway/codexGatewayState.ts`：共用 runtime 目录安全函数。
- `packages/happy-cli/src/codex/gateway/codexGatewayWorker.ts`：恢复前保障与安全 OS code 分类。
- 对应 CLI/App 单测：RPC、executor、routing、router、mapper、factory、state、worker 与 post-clear App command。
- `scripts/ci/codex-responses-fixture*`、Android field fixture、Maestro flow 和 shell gate：真实 post-clear 验收。
- `docs/cli-architecture.md`、`docs/agent-testing.md`：当前架构与验收契约。
- `packages/happy-cli/package.json`：`1.4.46 -> 1.4.47`。

## 验证矩阵

### `/clear`

- rollback response 更新本地 registry，但 `emitSnapshot:false` 时不产生 `thread/started`。
- allTurns 预读和 rollback RPC 都抑制 snapshot notification。
- zero-turn clear 不发非法 zero-turn RPC，但仍协调权威 idle snapshot。
- target thread、outcome thread 和 snapshot thread 任一不一致都失败。
- Router reconcile 与普通 notification 按 thread 串行，mapper flush 前 command 仍是 executing。
- 旧活动 turn/item 变为 interrupted，part final，runtime idle，历史内容仍可投影。
- 迟到 metadata 不能覆盖 active/systemError 的既有测试保持通过。
- App 在 interrupted turn + idle runtime 下找不到 active turn，下一条 prompt 生成 `turn.start`。

### Gateway

- 删除整个 runtimeRoot 后，worker 重建 root/leaf 并到达 running。
- Gateway ID、三个 socket 路径、secret、current/draining binding 不变化。
- 重建目录 POSIX mode 为 `0700`。
- runtimeRoot/runtimeDir symlink 被拒绝。
- allowlist OS code 精确持久化，descriptor 不含敏感 message/path marker。
- 旧 bridge `EACCES` 断言更新为安全的 `startup:bridge:EACCES`。

### 本地源码检查

```bash
pnpm --filter happy exec vitest run --project unit <targeted CLI specs>
pnpm --filter happy exec tsc --noEmit
pnpm --filter happy-app exec vitest run sources/sync/codexV4Commands.spec.ts
pnpm --filter happy-app exec tsc --noEmit
node node_modules/vitest/vitest.mjs run scripts/ci/codex-responses-fixture.test.ts
node_modules/.bin/tsc --noEmit -p scripts/ci/tsconfig.codex-official.json
bash -n scripts/ci/run-codex-android-field-e2e.sh
pnpm docs:sync
pnpm docs:check
git diff --check
```

本地不运行任何 build-coupled test 或发布构建。

### 本地验证与审查记录

- CLI `/clear`、Router、mapper、runtime factory 定向回归：6 个文件、170 项通过；独立审查补充的“rollback 后迟到旧 `thread/started` 不得恢复 active”回归也通过。
- Gateway state/worker 定向回归：2 个文件、39 项通过；覆盖原 Gateway 身份保留、目录重建、`0700` 和安全错误码持久化。
- CLI 完整 unit suite：102 个文件、973 项通过；最终 mapper 修订后再次运行 mapper 29 项及其相邻 Router/runtime factory 83 项，全部通过。
- CLI 与 App `tsc --noEmit` 通过；App post-clear 命令回归 9 项通过。
- Responses fixture 10 项、官方 Codex fixture TypeScript、Android Field shell `bash -n`、Maestro 双文档 YAML 解析全部通过。
- 第一轮独立 findings-first 审查发现迟到 active metadata 可在 rollback 后重新激活 runtime；实现改为忽略已知终态 turn 的旧 metadata，并禁止 metadata 覆盖 `systemError`，随后补充并通过回归。Gateway/Field 独立审查无 Critical、Important 或 Suggestion 级问题。
- 本地未构建 CLI 发布包、Android APK、官方 Codex、Web、Tauri 或 Rust；这些仍由 GitHub Actions 验收。

### 云端与发布

1. 完整本地验证和独立 findings-first 审查通过后，一次性提交并推送修复分支到 `origin`。
2. 创建目标为 `main` 的 PR，等待 Documentation、Monorepo Required CI gate、CLI Smoke Test 等全部相关检查。
3. 失败工作流先定位；卡住的 workflow 取消后重试，不无限等待。
4. PR 全绿后普通 merge，不 force push。
5. 合并后等待精确 merge HEAD 的 CLI Release、Monorepo CI 和 Official Codex Android Field E2E。
6. 下载 `happy-cli-1.4.47` artifact 中唯一 `happy-1.4.47.tgz`，校验 SHA-256、包版本和 macOS ARM64 `rg`/`difftastic` 归档。
7. 用已验证 tgz 升级本机 CLI，确认版本为 `1.4.47`。
8. 观察原四个异常 Gateway 使用原 ID 进入恢复流程；目录故障消除且后续状态兼容时必须恢复到 running，若暴露独立的旧协议或 binding 冲突则必须进入明确终态，不得继续每分钟盲重试，也不得以创建新 Gateway 代替恢复。
9. 记录 run ID、URL、artifact、哈希和现场状态；计划标记完成并移入归档，再对归档 HEAD 运行文档检查。

### 完成证据（2026-08-09）

- 实现提交 `03da36cf` 通过 PR [#23](https://github.com/KNaiFen/happy/pull/23) 合入 `main`，精确 merge HEAD 为 `3747ee11f0ff4b4eb50efc05c98f9a1d74bed8ac`。PR HEAD 的 Documentation run [`31302333326`](https://github.com/KNaiFen/happy/actions/runs/31302333326)、Monorepo runs [`31302293459`](https://github.com/KNaiFen/happy/actions/runs/31302293459) 与 [`31302333453`](https://github.com/KNaiFen/happy/actions/runs/31302333453)、CLI Smoke run [`31302333360`](https://github.com/KNaiFen/happy/actions/runs/31302333360) 均为 `success`。
- merge HEAD 的 Monorepo CI run [`31302985103`](https://github.com/KNaiFen/happy/actions/runs/31302985103) 为 `success`，17 个 job 全部通过；CLI、Wire、App、Server、Agent、官方 app-server、真实 TUI Gateway、传输故障和必需门禁均已完成。
- merge HEAD 的 Official Codex Android Field run [`31302985102`](https://github.com/KNaiFen/happy/actions/runs/31302985102) 为 `success`。诊断 Artifact [`codex-android-field-31302985102-1`](https://github.com/KNaiFen/happy/actions/runs/31302985102/artifacts/9035446981)（ID `9035446981`，GitHub digest `sha256:2dddfa0b4f3f8b0a4ed6ec897a2eb90eeecda51bda19a7e20c955a0dae6dd806`）使用官方 `codex-cli 0.147.0`，记录 `schemaVersion=13`、`phase=verified`、`providerPostClearFollowUpObserved=true`、`providerClearPromptObserved=false`、`rollbackCommandSucceeded=true`、`postClearRuntimeIdle=true`、`postClearHasNoActiveTurn=true` 和 `v4LifecycleCompleted=true`。本地下载后的 `field-diagnostics.json` SHA-256 为 `8b4f388f8c12b56ee52dbb3c1622bdb8c6f400033902527ba7d0280ad66587a2`。
- CLI Release run [`31302984993`](https://github.com/KNaiFen/happy/actions/runs/31302984993) 为 `success`。Artifact [`happy-cli-1.4.47`](https://github.com/KNaiFen/happy/actions/runs/31302984993/artifacts/9035094630)（ID `9035094630`，GitHub digest `sha256:99875bb0f48293ec7a711a98b53dafffa34ebaa1046a9fa125f48a2a0798d3c0`）只包含一个可安装的 `happy-1.4.47.tgz`；下载文件 SHA-256 为 `023d721031cc87ee1f970f3ea5ce63568c751e8eba389ad78a94f04e0af82cfd`，包版本、macOS ARM64 `rg`、`difftastic` 与 `ripgrep.node` 均已核验。
- 本机已从该 tgz 升级到 `happy 1.4.47`，注册 daemon 也报告 `1.4.47`。包内工具实际可执行：`ripgrep 14.1.1`、`Difftastic 0.64.0`，ARM64 `ripgrep.node` 存在。
- 升级重启后，四个原异常 descriptor 均以原 Gateway ID 和原确定性 socket 路径进入新 worker，缺失的 runtime 目录均被重建为当前用户所有的 `0700`。`214803f3...` 完整原地恢复为 `running`，三个 socket 均存在且为 `0600`；没有创建替代 Gateway。
- 其余 `28dad54f...`、`4b9175b9...`、`87f699fd...` 已越过原来的 `startup:control:unknown` 目录故障，完成 app-server 初始化并进入 bridge；随后分别以 `startup:bridge:rootBinding:providerSnapshot:protocol`、`startup:bridge:conflict`、`startup:bridge:rootBinding:providerSnapshot:protocol` 进入 `stopped`。这些是独立的陈旧 provider snapshot / binding 终态，不是 runtime 目录自愈失败；它们不再被 daemon 每分钟重启。现场验收因此证明了目录自愈、原 ID 复用和无限恢复循环消除，但不把三个不可恢复的历史 Gateway 误报为 running。

## 执行清单

- [x] 锁定 `/clear` 和 Gateway 两条根因及现场证据。
- [x] 从最新 `origin/main` 创建隔离修复 worktree。
- [x] 实现 rollback snapshot 专用协调与 turn/item/part 收敛。
- [x] 实现 Gateway runtime 目录自愈和安全错误分类。
- [x] 增加 App post-clear 命令、Android Field sentinel 和 schema 13 验收。
- [x] 更新当前架构文档和 CLI patch 版本。
- [x] 运行全部定向测试、typecheck 和静态检查；知识库同步在最终暂存快照上执行。
- [x] 完成独立 findings-first 审查并修复全部重要问题。
- [x] 一次性提交、推送分支、创建 PR 并等待 PR CI。
- [x] 合并后完成 CLI release、Android Field、产物下载与本机升级。
- [x] 验证原异常 Gateway 的目录自愈与终态收敛，记录证据并归档本计划。
