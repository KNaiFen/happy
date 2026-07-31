# Codex 会话生命周期、时间线与活动显示修复

## 状态

已于 2026-07-31 完成实现、审查、发布与云端验收，并同步到 `origin/main`。本计划归档，不再作为活动工作上下文。

## 已确认边界

- 仅 Codex 使用新的聊天内活动行；Claude 保持现状。
- Codex 业务阶段不做延迟或防抖。turn、item、MCP、工具、回复、审批和错误事件到达后立即投影。
- transport 连接状态与 provider execution 状态正交。断连不能把最后已知为 active 的 turn 改成 idle、completed 或 offline。
- active turn 没有真实 MCP、工具或流式回复可见时显示“思考中…”。真实内容出现时立即替代活动行；真实内容结束且 turn 仍 active 时立即恢复活动行。
- 归档由 relay 持久状态决定，App 立即隐藏会话；停止 CLI 是有界、后台的 best-effort 操作。
- 永久 tombstone 仅用于 Codex v4。非 Codex-v4 会话继续调用旧 `/v1/archive`，保持 Claude v3 的恢复语义不变。
- Codex stable-v2 通知进入 CLI 的顺序是实时 item 排序依据，不用 App、CLI 或 relay 的墙钟猜测顺序。
- 同一 turn 有并行工具时，只要仍存在任一运行中工具，就显示真实工具阶段而不是重新插入“思考中…”。

## 实施顺序

1. Server 增加可空 `Session.archivedAt` 及纯新增 Prisma migration。`/v4/archive` 幂等设置 Codex tombstone，心跳和所有写入口不得复活或修改已归档会话；历史读取仍可用。旧 `/v1/archive` 保持 transient `active=false`，供 Claude v3 和旧生命周期使用。
2. 增加仅原始终端机器凭据可调用的幂等 unarchive API，供 CLI 显式恢复原会话。App 的归档入口统一为服务端优先、按 session 去重的协调器，CLI kill 最长等待 5 秒且不决定归档成败。
3. Wire 为 `codex.item` 增加可选的 turn 内 `eventSequence`。CLI mapper 在 item 第一次进入串行通知管线时分配，snapshot 导入按稳定 fixture 验证的历史顺序初始化；后续 revision 不重排。
4. App projection 在同一 Codex turn 内优先使用 `eventSequence`，并让分组逻辑优先使用 provider turn ID，修复快速 MCP 被归入上一条用户消息的问题。
5. 修复 root thread 路由注册窗口：先发布内存绑定，再持久化；持久化失败时回滚并保留可重放通知。
6. App 增加不入库的 Codex 活动行。网络连接仅更新 connection 轴；重连补拉官方状态后才校准 execution。移除 Codex composer 的随机工作词。活动行按整个当前 turn 判断运行中工具，覆盖并行 MCP 交错完成的情况。
7. 增加跨 Codex app-server、CLI journal/mapper、HTTP relay 和 App projection 的场景测试，并把断连抖动、快速 MCP、陈旧 heartbeat 和路由持久化延迟加入必需 CI。

## 验收门槛

- 归档 HTTP 成功后会话立即消失，旧 socket、排队 heartbeat 和 v4 outbox 均不能使其复活。
- 同一 turn 中用户消息始终排在随后发生的 MCP、工具和回复之前，重启和 snapshot 后顺序不变。
- active turn 在任意次数的断连和重连之间持续显示最后活动阶段，不闪为无活动或离线。
- 官方 MCP、工具、回复、审批、错误和完成事件均无额外 1.5 秒延迟。
- Claude v3 归档仍走 `/v1/archive`，不会创建 Codex tombstone，也不要求修改 Claude CLI 的 resume 流程。
- thread/start 响应与首批通知交错时零 canonical entity 丢失。
- Wire、CLI、Server、App 的测试、类型检查和真实 HTTP 场景全部通过；不在本地运行 Cargo/Tauri 构建。

## 实施结果

- Server 新增纯加法 `archivedAt` migration、Codex v4 幂等 archive/unarchive、写入 tombstone 防护、cache 失效和单调 activity timestamp；`/v1/archive` 保持 Claude v3 transient 语义。
- App 将所有归档入口收敛到去重协调器，先乐观隐藏 Codex v4 会话并提交 relay tombstone，CLI kill 在后台限时执行；失败会回滚本地状态。
- Wire、CLI mapper 和 App projection 使用可选 `eventSequence` 稳定同一 turn 的用户消息、MCP、工具和回复顺序；本地 command 在 provider user item 到达前占用序号 0。
- root thread 路由先建立 provisional 内存绑定，再持久化 route；通知在注册窗口进入 durable orphan FIFO，持久化失败会回滚 route 并保留通知。
- Codex 活动显示改为聊天内带动效的“思考中...”，transport 断连不清除最后 active execution；MCP、工具、回复、审批、错误和 completed 立即切换，不做阶段防抖。
- 提交前审查补充了并行工具仍运行时不得恢复“思考中”，并验证非 Codex-v4 归档不会创建 tombstone 或要求 Claude resume 改造。

## 本地验证

- Wire：`66/66`；Agent：`227/227`；Server：`166/166`（含 100,000 mutation chaos）；App：`994/994`。
- CLI：`1124/1124`；其中沙箱内 `1116` 项通过，Claude scanner 因 macOS 沙箱 `EPERM` 单独在授权环境复验 `8/8`。
- App、CLI、Server 类型检查通过；frozen lockfile、HTTP 平台策略、workflow YAML、migration clean/upgrade/drift/index/cascade 和 `git diff --check` 通过。
- 真实 HTTP 链路覆盖 archive/resume、快速 MCP 先于官方 user item、重启、丢 invalidation、snapshot 410、approval、child、10,000 entity 和 20 个 5 Hz delta，p95 `243.7 ms`。
- 按项目约束未在本地运行 Cargo/Tauri；Server runtime Bun build、Web export、Tauri 和十分钟 turn 由云端 CI 完成。

## 云端验证

- 实现提交为 `c8076e31`，先由分支完整 CI `30625996440` 验证，再以普通 push 同步到 `origin/main`；未使用 force push。
- 主分支 monorepo CI `30626753483` 全部通过，覆盖 Wire、Agent、CLI、Server、App、Prisma migration、Server Bun runtime build、App Web export、Tauri `fmt/check/test --locked`、Codex stable-v2 schema drift、真实 HTTP relay、真实十分钟 turn、production Critical audit 和聚合门禁。
- Android API 36 现场 E2E `30626753504` 全部通过：独立 New Architecture x86_64 APK、真实 relay、Machine 鉴权、Codex `0.145.0` stable-v2、首条命令/回复、进程恢复和 canonical v4 断言均成功。
- CLI release `30626753479`、Android release `30626753529` 和 Debian 13 amd64 relay release `30626753485` 全部成功。
- CLI artifact `happy-1.4.10.tgz` 已下载并验证版本、Wire 依赖、macOS ARM64 `rg`/`difftastic` 归档及 SHA-256 `e8ed74d927eeeefea65a80dbd05fafb926bccc1920e42ec75abd3e909e2ef3fa`。
- Relay artifact `happy-relay-server-1.1.31-debian13-amd64.tar.gz` 已下载，并通过随附 SHA-256 校验；Android artifact `happy-app-1.11.17-android-arm64-v8a-no-ota` 已由工作流校验并保留在 GitHub，不默认下载到本地。

## 发布

已发布并验收 CLI `1.4.10`、App `1.11.17`、Server `1.1.31`、Wire `0.1.4`。这些版本已经运行发行工作流，后续修复必须继续递增 patch，不得复用。
