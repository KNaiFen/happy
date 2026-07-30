# Codex Sync v4 现场复验修复 R10

## 状态

实现已提交并进入 `origin/main`，主分支完整 CI 已通过；Android 现场工作流已
逐步越过构建、Maestro、fixture、Metro 和模拟器启动，目前正在修复首次启动与
development-client 深链之间的时序竞态。本文是本轮实现、测试和发布的权威
范围；发现新证据时先修订本文，再调整代码。

当前进度：

- 首条消息 v4 eligibility、Machine scope header、MMKV snapshot 自愈和零会话
  Machine 首页修复已实现；离线 Machine 明确显示离线并禁用新建入口，在线
  Machine 可直接进入新建页。
- 真实 HTTP/E2EE headless 场景已新增 projection 未激活首发、禁止 v3 fallback、
  CLI 回传和 App 重启恢复，最终现场场景通过，流式更新 p95 为 455.8 ms。
- Android 现场工作流和真实 daemon fixture 已实现；本地启动已验证真实 relay、
  terminal auth、daemon、零 session/在线 Machine 前置状态。首次无 UI 烟测按
  设计等待超时，退出时删除含临时凭据的 state 文件。
- 现场 fixture 暴露出 fake Codex 默认 turn 只产生 assistant item，与官方
  stable-v2 会同时持久化 user/assistant item 的语义不一致；在运行云端模拟器前
  先补齐 fake provider 的 user item 生命周期和完整 turn snapshot，保留至少两
  个 item/part 的严格验收。
- 差异审查发现 fixture 原先从 relay ready 起固定等待 120 秒，API 36 冷启动、
  APK 安装和 Metro 首次打包可能尚未结束就被误判失败。保留本地 120 秒默认值，
  云端工作流显式使用经过边界校验的 15 分钟 round-trip 窗口。
- CLI 全量并发测试中，两项 200/225 实体的持久传输压力测试分别在 5.01/5.14
  秒触发 Vitest 默认超时；相同测试单独运行约 3.2 秒且断言通过。仅为这两项设置
  15 秒上限，保留实体规模、持久化和全部断言，不降低覆盖强度。
- 安全复核发现 workflow 原先在 fixture 自清理目录内重定向父进程日志，文件会
  在启动时被解除链接，导致失败诊断和 artifact 缺失。父进程日志改放
  `RUNNER_TEMP` 独立路径；含凭据的 fixture 根目录仍保持启动清理和受限权限。
- 本地验证：仓库锁定 pnpm 10.11.0 frozen install；App `972/972`、Server
  `156/156`、CLI `1109/1109`；三端 typecheck、fixture 独立 TypeScript、
  workflow/Maestro YAML、Shell 语法和 diff check 均通过。生产依赖审计为
  `0 critical`，73 个 high 均为本轮前已存在且锁文件未变。
- 分支及 `main` 的完整 monorepo CI 均已通过，包括真实 Codex 0.145.0
  stable-v2 十分钟 turn、PostgreSQL 迁移、Tauri Rust、Web export、100k
  mutation chaos 和 provider-to-App 现场场景。
- 首轮 API 36 云端执行已完成 x86_64 APK 冷构建，但 Maestro `2.7.0`
  首次 `--version` 会向 stdout 输出匿名分析和功能提示，导致严格版本字符串
  校验失败，业务链路尚未启动。zip 固定校验和及可执行路径均已独立复核正确；
  修复方式是在 job 级关闭分析与功能提示后继续执行精确版本校验。
- 第二轮已通过 Maestro 精确校验并启动真实 relay/daemon fixture，但 Expo 日志
  已显示 `Waiting on http://localhost:8081` 时，固定
  `http://127.0.0.1:8081/status` 探针仍在 90 秒后超时。React Native DevTools
  的 Chrome sandbox 安装错误为非致命，Metro 进程保持存活。本地同一 Expo
  命令确认 `localhost/status` 返回 `packager-status:running`，而 IPv4
  `127.0.0.1` 立即拒绝连接；readiness 改为 Expo 实际声明的 `localhost`，
  不以固定 sleep 替代探针。
- 第三轮通过 Metro readiness 并启动 API 36 emulator；Maestro 首屏截图确认
  debug APK 停在 Expo Dev Launcher，因此普通 `launchApp` 不会加载 Happy
  bundle。APK manifest 已注册 `exp+happy`，按 Expo 官方自动化格式在清空状态后
  打开 `exp+happy://expo-development-client/?url=...&disableOnboarding=1`；进程
  死亡恢复也通过同一 deep link 冷启动，保留 MMKV/App 数据并避免回到 launcher。
- 第四轮确认 Android 已解析并派发上述 deep link，但 `launchApp` 返回时
  `MainActivity` 仍在创建，deep-link intent 在进程初始化前约 250 ms 到达；
  最终活动仍是 `DevLauncherActivity`，Metro 没有收到 manifest/bundle 请求。
  当前 `expo-dev-launcher` 源码确认 URL host、`url` 参数和 scheme 均正确，
  因此修复为先等待 Dev Launcher 的 `Development Build` 首屏完整可见，再派发
  deep link；不得继续增加 Happy 首页断言超时来掩盖启动 intent 竞态。
- 第五轮已越过 launcher、加载真实 Happy bundle，并从零 session 首页看到在线
  Machine 后进入 Codex 新建页；这两项现场缺陷的 UI 路径均已实际执行。失败发生
  在 Maestro `inputText`：API 36 设备服务逐字符输入到 `hello-from-a` 后卡住，
  120 秒无响应并触发 gRPC deadline，App、relay 和 daemon 均未收到发送动作。
  按 Maestro 官方抗抖动用法改为 `setClipboard` 后对已聚焦输入框执行
  `pasteText`，保留完整 canary、发送按钮和消息可见断言，不通过缩短文本或直接
  注入 App store 绕过 UI。
- 第六轮已通过 clipboard 输入、完整 canary 和发送动作，并由真实 Machine RPC
  创建 Codex v4 session；Android 随后在发布首个 `codex.command` 前抛出
  `_libsodium.default.crypto_aead_chacha20poly1305_ietf_encrypt is not a
  function`。daemon 日志确认 session 已启动但 v4 inbound journal 始终为空，
  因而不是 Codex 回复或 relay mutation 丢失。`@more-tech/react-native-libsodium`
  的 native 入口只实现 XChaCha20-Poly1305，TypeScript 声明却继承 web/sumo
  surface，导致 Node 单元测试使用 `libsodium-wrappers` 时产生假阳性。
- 修复保持 Sync v4 ciphertext version 1、12 字节 nonce、16 字节 tag 和现有
  CLI/OpenSSL 互操作格式不变；App 的标准 IETF ChaCha20-Poly1305 改由固定版本
  的纯 TypeScript 审计库实现，native libsodium 只继续提供已实际支持的随机数、
  box 和 secretbox 能力。不得改成 XChaCha 或静默生成新 wire version，否则会
  破坏已有 v4 snapshot 和当前 CLI。
- 本地修复验证已通过：native-surface mock 下 CLI 固定向量、默认随机 nonce
  加/解密和篡改拒绝共 3 项；App 全量 `88/88` 文件、`973/973` 测试和 typecheck
  通过，pnpm 10.11.0 frozen lockfile 通过，Expo Web export 成功解析并打包新的
  Sync v4 crypto 模块。生产依赖审计仍为既有 `0 critical / 73 high`；新增
  `@noble/ciphers 1.3.0` 无运行时依赖且没有新增 advisory。

## 现场现象

1. App 在新建 Codex 会话后发送首条消息，CLI 和 Codex 已完成处理，但 App
   会话为空或只保留本地输入，无法看到 assistant 回复。
2. 账户已有在线 Codex Machine、但尚无会话时，App 首页仍显示首次配对引导；
   用户必须先创建 Claude 会话，首页才出现 Machine 和新建 Codex 入口。
3. 现有场景测试覆盖 HTTP relay、WebSocket、轮询、E2EE、CLI mapper、App
   投影、snapshot、重启、子线程和长 turn，但绕过了 App 的启动协调器、
   首条消息路由和零会话首页状态。

## 已确认的证据

- 现场 Happy session 的服务器 v4 snapshot 包含完整 user item、assistant item、
  part、turn、runtime 和 thread；所有 CLI mutation 均已 ACK，CLI outbox 为零。
- 使用现场 session key 解密 snapshot，再调用生产
  `codexV4Projection`，可稳定投影出 user 与 assistant 消息。
- 现场首条 App 消息在 v4 projection 尚未 `activated` 时走了 v3
  `new-message`。当前 `sendMessage()` 以“已激活”而非“符合 v4 条件”选择协议。
- `CodexV4ClientRegistry.withClient()` 已支持在客户端 hydrate/start 期间持久发布，
  但上层激活判断阻止了这条路径。
- App v4 HTTP transport 未携带 session 来源 Machine ID。用户态 token 正常，
  但 credential-scoped token 会被 relay 按设计返回 404。
- App MMKV 若出现“receive cursor 已推进、entity cache 为空”的不一致状态，
  当前会从该游标继续拉取，无法自动恢复此前实体。
- UI 只等待 sessions 初次加载就标记 ready；machines 在后台加载。空会话页面
  无“machines 正在加载”或“已有 Machine、可新建会话”分支。

## 修复范围

### 1. 首条消息必须走 v4

- Codex 会话只要 metadata 满足 `flavor=codex` 且 `codexSyncVersion=4`，
  消息和控制命令就必须走 v4，不允许因 projection 尚未 ready 而降级 v3。
- 允许在空 projection 上生成首个 `turn.start`；由
  `CodexV4ClientRegistry.withClient()` 等待 create 阶段并先持久化 command。
- `publishCodexV4Command()` 以 eligibility 校验，并在发布前后重新校验会话归属、
  Machine 删除和 provider child 只读状态。
- 不符合 v4 marker 的旧 Codex 会话仍使用 v3，Claude 行为不变。

### 2. v4 传输与缓存自愈

- App v4 transport 为 session 请求增加 `X-Happy-Machine-Id`；Machine ID 来自
  加密 session metadata，不改变服务器授权边界。
- Server CORS 必须允许 `X-Happy-Machine-Id`，否则 Web/Tauri 跨域 v4 请求会在
  browser preflight 阶段失败；HTTP 场景必须断言该 header 出现在 allow-list。
- `receiveCursor > 0` 且本地 entity cache 为空视为不完整缓存，启动时强制
  snapshot。outbox 必须保留并在 snapshot 后继续发送。
- 为两项行为补 transport、persistence、client 和 registry 回归测试。

### 3. 零会话 Machine 首页

- 暴露独立的 machines 初次加载状态，不用 sessions ready 代替。
- machines 尚未完成权威加载时显示 loading。
- 已有 Machine 时显示 Machine 状态和明确的新建会话入口；在线 Machine 可直接
  打开新建页，离线 Machine 显示离线状态并禁用新建入口。
- 只有 machines 权威加载完成且确实为空时才显示扫码/手工配对引导。
- `/v1/machines` 非成功响应必须进入重试，而不是静默返回并永久停在未加载状态。

### 4. 贴近现场的 CI

普通 PR 必跑的 headless 场景：

1. 启动真实 Happy relay 进程和真实数据库，使用 HTTP 可信网络模式。
2. 走账户 token、terminal credential、Machine 创建和 session 创建接口。
3. 使用与 App 相同的 transport/persistence/投影核心，在 projection 尚未 ready
   时发送首条 v4 command；registry 的启动中持久发布另由单元测试覆盖。断言
   relay 中不存在对应 v3 消息。
4. 启动 CLI Sync v4、Codex command processor 和固定 stable-v2 fake
   app-server，产生 user/assistant/runtime 实体。fake provider 必须回显
   `clientUserMessageId` 为 user item 的 `clientId`，并在 completed turn
   snapshot 中同时包含 user 与 assistant item，不允许为迁就测试而降低实体
   数量断言。
5. 丢弃 WebSocket invalidation，验证 polling 收敛；终止并重建 App runtime，
   验证 MMKV 语义缓存和 snapshot 自愈。
6. 从零 sessions、一个在线 Machine 的 store 状态验证首页进入“可新建会话”，
   而不是配对引导。
7. 所有日志使用 canary 扫描，禁止 token、prompt、reasoning 和工具输出泄漏。

独立 Android 现场工作流：

- 构建仅供测试的 x86_64 APK，生产 APK 继续保持 arm64-v8a。
- 使用真实 PGlite、Happy relay、Happy CLI daemon、Machine RPC 和 stable-v2
  fake Codex app-server。fixture 必须通过正式账户/terminal auth 接口取得临时
  credential，禁止绕过 relay 直接注入 session。
- 在 API 36 x86_64 emulator 上使用固定版本 Maestro 驱动 Machine 零会话首页、
  新建 Codex、发送首条消息、收到 fake provider 回复、后台/前台、Android
  process death 和历史恢复。
- Maestro 固定版本归档必须先通过固定 SHA-256；job 必须关闭匿名分析与功能
  通知，避免首次运行提示污染 `--version` stdout，再严格校验版本号。不得删除
  固定版本或校验和来绕过安装失败。
- Android 文本录入使用 Maestro 内部 clipboard 的 `setClipboard`/`pasteText`
  原子路径，避免 API 36 上逐字符 `inputText` 卡死；输入框聚焦、完整 canary
  可见、发送按钮和最终消息仍由 UI 断言，不允许以 fixture/API 直接注入 prompt。
- App Sync v4 单元测试必须使用与 native surface 一致、明确不含标准
  `crypto_aead_chacha20poly1305_ietf_*` 的 libsodium mock，并继续匹配 CLI
  固定向量；Android 现场工作流必须实际执行一次加密和一次解密，单纯检查导出名、
  TypeScript 类型或 Node `libsodium-wrappers` 不算通过。
- fixture round-trip 等待时间必须由受限整数环境变量控制；云端冷启动窗口设为
  15 分钟，不使用无界等待，也不把模拟器启动耗时误报为 Codex 消息丢失。
- App 仅在 `__DEV__` 且显式 CI 环境变量存在时，自动写入临时凭据并允许
  loopback HTTP；production bundle 中该路径保持关闭。关键控件使用稳定
  `testID`，不依赖语言或布局坐标。
- 开发 APK 必须先以 `clearState` 建立干净基线，再通过 APK 已注册的
  `exp+happy` Expo development-client deep link 加载反向代理后的 Metro；
  首次 `launchApp` 后必须先观察到 Dev Launcher 首屏已完整渲染，再发送 deep
  link，避免 `MainActivity` 初始化期间的第二个 intent 丢失。首次 bundle 等待
  保持有界但覆盖冷编译。进程死亡测试不得清除 App 数据，并以同一 deep link
  冷启动 bundle 后验证历史恢复。
- relay、fake Codex 和 App 日志及失败截图作为 artifact 上传。
- Metro readiness 必须探测 Expo 实际声明的 host/endpoint，并同时确认父进程
  存活；不得因 `localhost`/IPv4 解析差异误判，也不得用无条件等待掩盖 bundler
  失败。
- fixture 父进程日志不得位于 fixture 启动时递归清理的根目录内；失败分支必须
  能直接读取并上传该日志。
- 该工作流在 `main`、手工触发和夜间运行；PR 必需门保留 headless 场景，以控制
  时间和模拟器偶发失败。
- 新 workflow 只有进入默认分支后才可由 GitHub 注册并手工 dispatch；首次由
  `main` push 自动触发，后续修复可在分支注册存在后手工复跑。

### 5. 版本与交付

- App：首轮修复已发布 `1.11.13`；Android native AEAD 修复推进到 `1.11.14`，
  不复用已运行 release workflow 的版本。
- CLI：合并当前独立 `--version` 修复，`1.4.7 -> 1.4.8`。
- Server：因新增 v4 Machine scope CORS header，`1.1.27 -> 1.1.28`。
- Wire 无协议或运行时代码变更，不推进版本。
- 完成本地最小测试和全量相关测试后，以中文主题提交并推送 `origin`。
- 压力/现场测试的框架超时必须覆盖全量并发负载，但保持有界；不得通过减少
  mutation、分页或恢复断言来消除超时。
- 跟踪所有 GitHub Actions；失败则修复、推进受影响版本并再次提交，直到必需门
  全绿。发布后提供 CLI 包和 Android artifact 地址。

## 验收

- 新 Codex v4 会话的第一条 prompt 在 projection 未激活时也生成
  `codex.command`，不生成 v3 `new-message`。
- CLI 接收 command 后，App 在健康链路 750 ms p95 内看到 user/assistant
  更新；丢 invalidation 后仍通过 polling 恢复。
- App 重启、空缓存配高游标、relay/CLI 重启后，最终投影与服务器 snapshot 一致。
- 零会话但已有 Machine 时，首页立即可新建 Codex，不要求先创建 Claude。
- credential-scoped App 请求在携带正确 Machine ID 时可读取所属 session v4；
  错误 Machine ID 仍被拒绝。
- CI 的 headless 现场场景和 Android 模拟器场景均保留可诊断 artifact，且不记录
  明文敏感数据。
- Android 场景必须由 App UI 发起真实 `spawn-happy-session` Machine RPC，
  daemon 启动真实 Happy Codex 子进程；只验证预置 session 不算通过。
