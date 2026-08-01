# Codex 过往会话选择与 Resume（已完成）

## 状态

- 状态：完成并归档
- 基线：`main@f371de5fd9eb3edd11eade0ffd894ea865eacc7f`
- 目标版本：App `1.11.20`、CLI `1.4.14`、Server `1.1.33`
- Wire 保持 `0.1.5`

## 目标

在设备详情页复用现有路径输入框，提供“新建对话”和“打开过往对话”两个入口。过往对话来自该机器、该路径下的官方 Codex stable-v2 历史；选择后恢复原 Happy 会话，或为从未接入 Happy 的官方线程创建唯一的新 Happy 会话并完成 Sync v4 历史导入。

只显示未归档、非临时、非子代理的根线程。功能默认启用，不依赖 `expResumeSession`。

## 交互与接口

- 新增 E2EE machine RPC `codex-list-threads`：接收绝对路径、标题搜索词和游标，每页返回 50 条规范化线程摘要。
- 新增 E2EE machine RPC `codex-open-thread`：统一完成绑定核对、并发合并、原会话恢复和外部线程接入。
- `thread/list` 固定使用 `cwd` 精确匹配、`archived: false`、`recency_at desc`，来源包含 `cli`、`vscode`、`exec`、`appServer`、`unknown`；响应再次排除 ephemeral、parent thread 和 subagent。
- Machine metadata 增加可选 `resumeSupport.codexThreadHistoryRpcAvailable`，新 App 对旧 CLI 显示升级提示。
- `GET /v2/sessions` 增加可选 `originMachineId` 过滤，App 通过游标分页核对该机器的全部加密 Happy 历史；响应和数据库不变。

## 正确性与安全

- App 必须先完成 Happy 绑定扫描；任意分页、解密或游标错误都保持“未知”并阻止创建，不能将失败降级为“外部线程”。
- 同一 Codex thread 的打开请求按 thread ID 合并；双击、两台 App 和重试不得创建重复 Happy 会话。
- 已绑定且活跃时直接打开原 session；已绑定且不活跃时复用现有 v4 unarchive 和 reconnect 流程。
- daemon 缺失本地恢复记录时先返回 `resumeMaterialRequired`。App 仅通过 E2EE machine RPC 补回该 session 的独立 data key；CLI 再从 Relay 读取最新 seq 和版本、解密并验证 machine/path/thread 后恢复。legacy 主密钥绝不传递，也不允许重复创建兜底。
- 外部线程的新 session key 由 App 以账户主密钥对 `machineId + threadId` 做域分离派生；CLI 使用该 key 生成 HMAC session tag。重试命中同一 Happy session，Relay 看不到真实 thread ID。
- 所有 key、provider ID、路径内容和 RPC payload 均不得进入日志；本地 session key 文件和临时文件保持 `0600`。
- 打开前使用 `thread/read(includeTurns:false)` 重新验证路径、根线程和当前 history app-server 可见的状态；该进程明确返回 external active 时禁止成为第二写入者。
- 已绑定线程也必须把“当前 history app-server 返回 active 但本机无对应 Happy 进程”视为外部写入者并阻止恢复；已启动子进程的 PID 与 session 快照同步持久化，使 daemon 在 webhook 前重启时仍不会重复启动。
- 官方 stable-v2 的 `ThreadStatus` 是单个 app-server 的内存状态，`thread/read` 对冷历史返回 `notLoaded`，且协议尚未暴露跨进程订阅者 presence 或 rollout 写锁。因此本功能严格保证 Happy 自身不双写；无法对独立官方 CLI 的主动并发写入作出协议层零冲突承诺。
- 外部线程使用当前 App Codex 默认模型、权限和 effort；已有 Happy session 只使用自己的 session-level override，并补齐 resume 对 effort 的传递。
- machine RPC 的路径、游标、搜索词、provider/session ID、模式和 key 全部设置显式长度边界；CLI 对 Relay 会话分页响应做运行时结构校验后才解密。

## UI

- 路径框尾部放置历史图标和现有前进图标，保证稳定尺寸、tooltip 和无障碍名称。
- 新增响应式线程选择 sheet：标题搜索 300ms 防抖、分页、显式选择和确认，显示标题/预览、更新时间、来源、状态和 Happy 绑定状态。
- Happy 绑定核对完成前禁用确认；外部 active、legacy、重复绑定和结果未知显示明确原因。
- 加载更多失败时保留已有结果、显示可恢复错误并允许重试，不得静默吞掉分页失败。
- 删除设备页英文 `Previous Sessions` 调试区，由正式选择器取代。
- 新增文案同步到 `_all.ts` 声明的所有 locale，说明文字允许换行，不用省略号隐藏错误原因。

## 测试与验收

- Server：机器过滤、分页、无权访问、deleted machine 和游标边界。
- CLI：stable-v2 请求形状、过滤、搜索/分页、app-server 恢复、绑定重建、错误 key、legacy 拒绝、模式保持、外部 active 和并发幂等。
- App：路径解析、旧 CLI、离线、绑定扫描超过 150 条、重复绑定、搜索竞态、分页、错误恢复和响应式布局。
- Chaos：双击、两台 App、spawn/POST 后退出、daemon 重启、RPC 结果未知；同一 thread 最终最多一个 Happy session。
- 云端：最新稳定版官方 Codex app-server 执行 `thread/list/read/resume`；Android API 36 field E2E 从设备页选择旧线程、恢复完整历史、发送消息并验证重启恢复。
- Android field 必须把应用反馈弹窗视为可在任意关键导航点出现的真实异步 UI：出现时条件关闭，不出现时继续。不得假设它只在发送首条消息后出现，也不得用等待反馈弹窗代替业务断言。
- Codex 只要已经协商启用 Sync v4，就必须从进程启动起禁止新增 v3 内容；`canonicalV4Active` 只表示 v4 历史迁移及投影切换完成，不能作为允许 v3 输出的条件。迁移前 App 可继续显示已有 v3 历史，但 CLI 不得在 `thread/resume/read` 导入窗口把官方历史或 live notification 双写回 v3。
- 本地只运行源码 Vitest、`tsc --noEmit`、翻译比较和开发服务器；构建、打包、Android、Docker、Rust/Tauri 和官方 Codex 源码都留在 GitHub Actions。

## 发布

- 完成后更新状态和验收证据，并移入 `docs/plans/archive/`。
- 推进 App、CLI、Server patch 版本，中文提交并推送 `origin/main`。
- 等待 monorepo CI、官方 Codex、Android field、CLI release、Android release 和 Debian Relay workflow 全部通过；失败则修复并推进受影响版本，禁止复用已运行的 release 版本。

## 实施证据

- App：完整 Vitest `97` 个文件、`948` 项通过；`tsc --noEmit` 通过。
- CLI：完整 unit Vitest `92` 个文件、`880` 项通过；`tsc --noEmit` 通过。
- Server：完整 Vitest `25` 个文件、`170` 项通过，包含 `100,000` mutation chaos；`tsc --noEmit` 通过。
- Wire：完整 Vitest `7` 个文件、`66` 项通过，版本保持 `0.1.5`。
- 云端场景源码：官方 app-server/Android fixture TypeScript 通过；全部 workflow 与 Maestro YAML 可解析；Android field shell 通过 `bash -n`；`git diff --check` 通过。
- 云端已证明：monorepo CI 全绿；最新稳定版官方 Codex 源码构建及 `thread/list/read/resume` 场景通过；CLI `1.4.12`、Android `1.11.20` 和 Debian Relay `1.1.33` 发布构建通过。
- Android field 首轮现场：零机器 bootstrap、零会话 App surface、真实中继、官方 Codex provenance、历史线程选择和在线会话导航均通过；`agent-input-message` 等待被已显示的 `Enjoying the app?` 原生模态遮挡。修复为关键点条件关闭反馈弹窗，并删除“发送后必须出现”的错误测试边界。
- Android field 第二轮现场：反馈弹窗处理已通过；恢复进程在 v4 migration 尚未 ready 时收到官方历史通知，`CodexLegacyOutput` 因 `canonicalV4Active=false` 将一问一答写入 `/v3/sessions/:id/messages`。field 的零 v3 断言正确失败并关闭临时中继，后续 UI 空白和滚动超时是该主动关停的结果，不是历史投影或滚动方向问题。
- 修复要求：v4 已启用时旧输出适配器全程只读/静默，不因在线、离线或 migration 状态回退；增加 migration-pending 在线场景回归测试，保留 field 的零 v3 强断言。
- Android field 第三轮现场：`CodexLegacyOutput` 修复已把 v3 记录从两条降为一条，但 `resumeExistingThread` 的聊天内恢复公告直接调用 `session.sendSessionEvent`，绕过统一旧输出门；fixture 再次按零 v3 断言关闭中继，CLI 尚未 ACK 的 23 条 v4 历史 mutation 因此未到达 App。
- 修复要求：resume 策略同时决定 legacy snapshot 与 legacy announcement；v4 任意 migration 状态下两者都必须关闭。`resumeExistingThread` 的公告参数改为必填，避免未来调用方无意默认写入 v3。
- 最终本地验收：CLI `92/92` 个源码测试文件、`881/881` 项通过，`tsc --noEmit` 与 `git diff --check` 通过；未在本地执行构建、打包、Cargo、Android 或官方 Codex 源码编译。
- 最终云端验收：Monorepo CI `30710663462`、CLI `1.4.14` 发布 `30710663407`、Android field `30710663480` 全部通过。官方 source provenance 为 `codex-cli 0.146.0`、tag `rust-v0.146.0`、commit `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`。
- 最终 field 诊断：`v3MessageCount=0`，`commandAccepted=true`，`cliRoundTripObserved=true`；v4 snapshot 包含 1 个 command、1 个 commandResult、2 个 turn、6 个 item、5 个 part、1 个 runtime 和 1 个 thread，provider 收到 3 次请求并观察到 tool output。零机器 bootstrap、零机器 App surface、真实 resume/继续发言及进程死亡恢复四个 Maestro 流程全部零失败。
- 发布制品：App `1.11.20`、Server `1.1.33` 和 Wire `0.1.5` 未因两次 CLI-only 修复继续推进；CLI 最终版本为 `1.4.14`。
