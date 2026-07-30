# Codex Sync v4 现场复验修复 R11

## 状态

R10 的 Android API 36 现场场景已真正经过零会话首页、Machine RPC、新建 Codex
会话和首条消息发送动作，但在 relay 收到首条 mutation 时失败。本文件是该现场
回归的后续权威计划；完成后将 R10/R11 一并归档，避免活动上下文继续膨胀。

## 云端现场平台阻塞

GitHub Actions run `30572012765` 在零 Machine bootstrap 阶段失败。下载的
Android artifact 表明：

- Maestro 的 `openLink` 已实际发出 `exp+happy` 的 `VIEW` intent，Android
  ActivityManager 两次确认 `com.slopus.happy.dev/.MainActivity` 被启动。
- Metro 初次加载较慢后，React Native 已执行 `Running "main"`；随后进程在
  Android API 36 x86_64 emulator 的 Fabric
  `MountingCoordinator::pullTransaction` 发生 `SIGSEGV`。桌面截图是 native
  进程崩溃后的结果，不是 App 未被深链启动的证据。
- 崩溃发生在 Happy 首页和任何 Sync v4 mutation 之前，因此不能把这次失败归因
  为 v4 传输，也不能让它掩盖首条消息回归的验收。

该问题目前只在 GitHub 托管的 API 36 x86_64 现场测试中复现；它不证明或反证
真实 arm64 设备的 Fabric 状态。生产 App 的 New Architecture 配置不因此改变。
本地随依赖安装的 React Native `0.83.1` Gradle 插件同时确认，从 `0.82` 起
`newArchEnabled=false` 已不再受支持且会被忽略，因此不得用 legacy-renderer
构建制造错误的绿色验收。

GitHub Actions run `30579843712` 随后证明 standalone 方向有效：

- New Architecture release-type APK 成功构建、普通 launcher 冷启动，零 Machine
  首页断言通过，不再复现 Dev Launcher/Fabric 启动崩溃。
- App 创建 Codex 会话并发送首条 canary 后，relay、CLI 和 stable-v2 fake Codex
  已完成真实往返。安全诊断报告为 `verified`，v3 message 为 `0`，snapshot 含
  `codex.command`、`codex.commandResult`、两个 `codex.item`、两个
  `codex.part`、`codex.runtime`、`codex.thread` 和 `codex.turn`。
- 失败截图中 `Fake Codex response` 已实际渲染；Maestro 的可见性断言失败，是
  首次创建会话后 App 正常弹出的 `Enjoying the app?` 反馈对话框遮挡了底层会话，
  不是 v4 消息未到达。

现场流程必须把该真实首次使用弹层作为用户路径的一部分：等待反馈对话框、选择
`Not really` 使回答持久化，再断言首条回复和进程死亡恢复。不得通过关闭产品反馈
逻辑或直接写 MMKV 绕过弹层。

GitHub Actions run `30582342821` 使用相同 App 源码复验上述弹层路径时，在
Maestro 启动前的 Gradle `:app:packageRelease` 阶段失败。日志仅包含
`PackageAndroidArtifact$IncrementalSplitterRunnable` 外层异常，没有底层堆栈；
第一次现场 run 的相同 APK 构建已成功，因此目前既不能把它归为产品回归，也不能
在没有诊断证据时把重跑成功当成已修复。

现场工作流应为 APK 打包增加以下可诊断性：

- Gradle 必须带 `--stacktrace`，保留实际打包异常链。
- 构建前后（包括失败路径）记录 runner 根分区可用空间，区分磁盘耗尽与 Android
  packaging 工具自身异常；只记录容量，不遍历或上传 runner 文件。
- 失败 artifact 纳入 Android/Gradle problems report，但仍不得上传现场 APK、
  一次性凭据或任何明文业务内容。
- 若后续运行成功，只有在容量证据正常且真实 UI 场景也通过时才能判定本次为云端
  runner 瞬时故障；若再次失败，则依据完整堆栈继续修正本计划和工作流。

## 已确认根因

- `HttpAppSyncV4Transport` 为 v4 请求构造 `Headers`，以保留 trace 和
  `X-Happy-Machine-Id`。
- `apiSocket.request()` 随后用对象展开合并 `options.headers`。`Headers` 的字段
  不可枚举，导致 Android 实际请求丢失 `Content-Type`、trace 和 Machine scope。
- relay 因缺少 JSON content type 把请求体作为非对象处理，Fastify/Zod 在 route
  handler 前返回 HTTP 400。没有请求 trace 的服务端生成随机 trace，App 只显示
  “trace echo 不匹配”，遮住了真正的校验失败。
- 现有零会话首页仍以 `machinesLoaded` 为前提。实时 `new-machine` 已把 Machine
  合并进 store、但首次权威 fetch 尚未结束时，该页面继续显示 loading/配对状态，
  用户必须经过其他页面触发后续刷新。

## 修复范围

### 1. 保留所有 v4 HTTP 头

- 在 App 的统一 HTTP 请求入口使用 `Headers` API 合并认证、client 标识和调用方
  头，不再展开 `HeadersInit`。
- 强制保留 v4 的 `Content-Type`、`X-Happy-Sync-Trace` 和
  `X-Happy-Machine-Id`，同时确保 bearer token 与当前 App client 标识不可被调用方
  覆盖。
- 新增纯函数回归测试，覆盖对象、数组和 `Headers` 三种 `HeadersInit`，并由
  `HttpAppSyncV4Transport` 的端到端 adapter 测试验证首条 mutation 的实际请求
  形状。

### 2. 保持失败可诊断但不泄露内容

- 已验证 Server 的 `attachSyncV4Trace` 会为已接受的合法 trace 回显 response
  header；新增 Fastify 注入测试锁定 mutation validation failure 的该行为。
- App 对非成功响应继续先验证 trace，再报告固定 HTTP 状态。R11 的实际问题是请求
  根本没有带 trace；修复统一 header 合并后不需要放宽这一完整性检查。
- 增加 Fastify 注入测试，固定覆盖带 trace 的 malformed mutation，断言 400
  response 仍带原 trace；测试和日志不含输入值。

### 3. 零会话 Machine 可见性

- `EmptyMainScreen` 与 tablet 对应状态机在 store 已有至少一个 Machine 时立即进入
  “新建会话”状态，不等待不相关的全量 Machine fetch 完成。
- 仍只有在“无 Machine 且权威 snapshot 已完成”时显示配对引导；无 Machine 且
  fetch 进行中保持 loading，避免错误地提示用户重新扫码。
- 覆盖实时 Machine 先到、权威 fetch 后到，以及 fetch 返回空集合三种状态。

### 4. 更贴近现场的 CI

- Android API 36 场景保留真实 PGlite relay、正式 auth API、真实 CLI daemon、
  stable-v2 fake Codex、Machine RPC 与 UI 操作，不以 store/API 注入替代首条消息。
- 不再用 Metro/Dev Launcher 承载业务验收。工作流先启动真实 relay/auth fixture，
  再构建 development 包名、debug 签名但使用 release build type 的 standalone APK；
  它保留 New Architecture、Hermes 和内嵌 production-mode JS bundle，通过普通
  launcher 冷启动，更接近最终 arm64 发布包。
- standalone 现场 APK 只在 `APP_ENV=development` 且显式
  `HAPPY_MOBILE_FIELD_E2E=1` 时允许从编译环境读取一次性测试凭据并启用 fixture 的
  HTTP relay。生产/preview 配置遇到该标记必须在配置阶段失败；CI 对凭据做 mask，
  不上传 APK、凭据、明文消息或密钥。
- Android UI 流程拆成零 Machine、Machine 实时到达、业务交互和进程死亡恢复四个
  可观察阶段。任一阶段失败都留下 activity、logcat、Maestro hierarchy 和截图，
  不再把 Dev Launcher/Metro 生命周期问题误报为同步失败。
- 首次会话建立后的真实反馈对话框由 Maestro 显式等待并选择拒绝；随后才验证
  assistant part。该步骤同时保证弹层不会遮挡回复断言或在进程死亡恢复阶段再次
  出现。
- fixture 在每个场景完成后写出仅含 hash、v3 计数和 v4 entity 类型计数的安全
  验收报告；CI 必须解析并校验该报告，不能只等待完成标记。失败 artifact 同时上传
  relay/CLI 日志与报告。
- 增加强制断言：Android 发出的 mutation 必须由 relay 接受、CLI journal 必须看到
  inbound command、最终 snapshot 必须含 user/assistant/runtime/turn/item/part，
  且 relay 的 v3 stream 为空。
- 增加一个零会话时“实时 Machine 后到”的独立 UI 场景，防止 fixture 预置 Machine
  掩盖首页加载竞态。
- 后续提升路径：每日夜间在上述真实链路中轮换 relay restart、丢 Socket
  invalidation、CLI restart 和 App process death；PR 保留 headless 组合测试，
  默认分支/夜间保留 API 36 emulator gate。

## 非目标

- 不修改 Sync v4 ciphertext v1、stable-v2 协议、Codex 最低版本或 HTTP 安全策略。
- 不放宽 Web 的 HTTPS/localhost 限制。
- 不记录端到端加密数据的任何明文或可逆标识。

## 版本与验收

- App 首条同步和零会话修复已推进 `1.11.14 -> 1.11.15`；新增受严格构建标记约束
  的 standalone 现场测试入口后再推进到 `1.11.16`。
- Server 为避免旧 App 继续静默发送错误形状的 mutation，将 Codex Sync v4 的协调
  最低 App 版本提升到 `1.11.15`，并推进 `1.1.28 -> 1.1.29`。旧 App 必须收到
  明确的 426 升级响应，不得继续尝试 v4 首条命令；测试入口不改变线上协议，因此
  Server 最低版本保持 `1.11.15`。
- CLI/Wire 无发布代码变更，不推进版本。
- 本地完成 App/Server 相关测试、typecheck、Web export、workflow/YAML 校验和
  `git diff --check` 后提交并推送 `origin/codex/sync-v4`。
- 云端先运行普通 CI 和 Android field workflow。任何失败都以本文件为基准补充
  根因、修复、递增受影响版本、提交并重新运行，直到 required checks 与 Android
  现场场景均通过。
