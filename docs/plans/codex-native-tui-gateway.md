# Codex 原生 TUI Gateway 实施计划

## 状态

- 当前状态：实施中
- 日期：2026-08-02
- 基线：`main` / `4cce2cb4`
- 目标版本：CLI `1.4.22`、App `1.11.22`、Wire `0.1.6`
- Server 保持 `1.1.33`，除非实现过程中确认必须修改中继契约
- 本文件是本次重构的唯一权威实施基线。发现新事实时，必须先更新本文件，
  再改变代码方向。

## 目标

`happy codex` 启动官方 Codex TUI，终端使用体验与直接执行 `codex` 保持一致，
同时由独立 Happy Gateway 连接同一个官方 app-server，将同一 thread 通过 Sync v4
同步到 App。终端与 App 都能发送消息、处理审批和查看完整官方生命周期；终端异常
断开后 Gateway 与 provider turn 继续运行，用户可通过 `happy codex attach` 回到原
TUI，而不是创建或 resume 第二份 provider 运行时。

## 已锁定的产品契约

### 命令入口

- `happy codex`、初始 prompt 和 Codex 原生 flags 启动同步的官方 TUI。
- `happy codex resume`、`happy codex fork` 直接使用官方选择器和原生行为。
- TUI 内 `/resume`、`/new`、`/fork` 可切换 Gateway 当前绑定。
- `happy codex attach` 总是展示本机可附着 Gateway 选择器；也接受精确 thread ID
  或 gateway ID。
- `happy codex stop` 总是展示本机 Gateway 选择器；也接受精确 ID，`--force`
  表示立即终止并把执行结果标为未知。
- `happy codex --help` 和 `happy codex --version` 显示官方 Codex 输出。
- `happy codex login|mcp|exec|review|...` 等非交互同步入口透明委派给官方 Codex，
  不创建 Happy session。
- 裸 `happy` 显示 Happy 命令帮助、daemon 和 Gateway 状态，不再隐式启动 Codex。
- 拒绝用户传入 `--remote` 和 `--remote-auth-token-env`，避免绕过受控 Gateway。
- 移除旧的 `happy codex --resume` 兼容入口，不长期保留双语法。

### 官方协议边界

- 不 fork、不 patch 官方 Codex；TUI 通过官方 `codex --remote` 连接。
- Happy canonical 协议仍只使用 stable-v2，最低支持 `codex-cli 0.145.0`。
- 官方远程 TUI 与本地 stdio TUI 的差异由产品接受；Happy 不伪造 TUI 控件。
- 代理透传 JSON-RPC，不改写 provider payload。仅观察、预检并记录成功的根
  `thread/start`、`thread/resume`、`thread/fork` 绑定变化。
- Happy bridge 作为 app-server 的独立订阅者；TUI 和 bridge 同时接收通知。
- 只同步官方 reasoning summary；raw reasoning text 只允许本地计数诊断，永不
  写入 Sync v4 或日志。

### Gateway 生命周期

- 每个终端窗口对应一个独立 Gateway worker 和一个官方 app-server。
- terminal-origin worker 由前台 launcher 脱离启动并继承当前终端环境，然后向
  daemon 注册；App-origin worker 由 daemon 使用其 profile 环境启动。
- worker 独立拥有 app-server、透明本地代理、Sync v4 bridge、持久 journal、
  thread lease、control endpoint、心跳和恢复描述符。
- daemon 重启后扫描描述符、control endpoint 和心跳，重新发现仍存活的 worker。
- worker 自身退出但 descriptor 未进入 `stopped` 时，daemon 或下一次
  `happy codex attach|stop` 使用同一 gateway ID 重启 worker；恢复沿用原 journal、
  session key seed、thread lease 和精确 generation。journal lease 必须先于 descriptor
  PID 改写取得，仍存活的旧 worker 会拒绝第二个 owner；PID 重用通过 Happy worker
  argv marker 校验，不把无关进程当成 journal owner。
- descriptor 同时保存官方 app-server PID。worker 重启先核对该 PID 的 Codex
  `app-server --listen <Happy 专属 endpoint>` argv 与 endpoint 可达性：可达时接管原
  provider，保留正在运行的 turn；不可达时只终止这个已严格验证的孤儿，再启动新的
  app-server 并读取权威 snapshot。不得因 POSIX socket unlink 或 Windows 端口占用
  静默形成两个 provider。
- PID 检查必须区分 `expected`、`unexpected` 与“进程仍存活但 argv 暂时不可读”。最后
  一种是 ownership 未知：保留 descriptor 与 endpoint、进入可重试 recovering，既不得
  unlink socket，也不得终止或替换 provider；只有 `expected` 且 endpoint 不可达时才可
  复核后终止。
- app-server 崩溃时 worker 有限退避重启，重新订阅 current 和 draining thread，
  读取权威 snapshot；未知的非幂等 RPC 不自动重放。
- POSIX 使用私有目录和 Unix socket，目录与 socket 权限为 `0700`；Windows 使用
  loopback WebSocket 和随机 capability token。控制令牌与状态文件为 `0600`，
  daemon 控制接口也必须鉴权。

### 终端断开与重新附着

- TUI 连接消失后进入 10 秒 `pendingDetach`，等待 launcher 的一次性正常退出确认。
- launcher 为每次 TUI attach 生成独立的 attachment ID 与一次性退出 nonce，并在
  TUI 启动前通过鉴权 control endpoint 注册。worker 只接受当前 attachment 已断开且
  处于 `pendingDetach` 时匹配该 attachment ID 与 nonce 的正常退出确认；旧 launcher
  的迟到确认不得停止已被新终端重新附着的 Gateway。
- 收到匹配 attachment 与一次性 nonce 的正常退出确认时：terminal-origin Gateway 停止，Happy
  session 保留为可读的 inactive 历史；App-origin Gateway 恢复为 headless。
- 未收到确认时进入 `terminalDetached`，不结束 app-server、turn 或 Sync bridge。
  App 保持发送、steer、interrupt、审批和 user-input 能力。
- 电脑休眠但进程与连接未断开时不改变状态。
- `attach` 只连接原 Gateway，不创建第二个 app-server 或 provider runtime。由于新的
  官方 TUI 进程没有旧 UI 内存，它必须在同一 app-server 内发送一次官方
  `thread/resume` 来恢复历史与订阅；该调用不得启动、重放或复制既有 turn。
  选择器展示当前目录优先的 title、path、状态、断开时间和短 ID。

### Thread 独占与切换

- 同一 provider thread 同时只能由一个 Gateway 持有。lease 使用本地密钥对 thread
  ID 做 HMAC，不把 provider ID 写入日志或普通文件名。
- 冲突时 provider 根 RPC 返回明确错误，当前 TUI 绑定不改变，并提示使用 attach。
- 根 start/resume/fork 成功后，Gateway generation 单调递增，目标 Happy session
  先准备和同步 snapshot，再成为 current。
- 源 session 立即从主列表隐藏并成为 draining；其已提交 turn 继续在原 bridge
  中运行，直到权威完成、命令对账和 outbound ACK 全部完成后才 archive、释放 lease。
- App 正在查看源 session 时，仅在同一 gateway 和预期 generation 验证通过后自动
  导航目标 session；App 在其他页面时只刷新主页列表。
- 目标同步期间 composer 可编辑草稿但禁止发送；草稿不会自动发送。
- 源绑定中尚未提交 provider 的命令取消并恢复到原 App 草稿；已提交命令留在源
  session 对账。
- relay 离线不阻塞 TUI 切换；handoff intent 与 entity mutation 先写本地 journal，
  后续重放。

### 命令、审批与停止

- App 新命令携带当前 `bindingGeneration`；worker 在调用 provider 前拒绝过期命令。
- active turn 的 App follow-up 保持现有语义：steer 走 `turn/steer`，queue 使用持久
  FIFO，等待权威完成后提交。
- prompt/steer 的 `clientUserMessageId` 等于 Sync v4 `commandId`。
- 审批和 user-input 可由 TUI 或 App 回答，provider 接受的第一份响应获胜；
  `serverRequest/resolved` 关闭另一端。
- 正常 stop 遇到 active turn 时先发送带 expected turn ID 的 `turn/interrupt`，等待
  权威状态；等待超时只标记 result unknown，然后停止，不伪造 completed/idle。
- App 的 session 菜单提供 Gateway stop；archive 等价于 stop 后隐藏，历史保留。
- App 的 machine-scoped stop 请求必须携带 metadata 中的 gateway ID 与 binding
  generation；daemon 在受理前同时核对 session、gateway、generation 且目标仍是
  descriptor 的 current binding，拒绝 handoff 前旧页面发出的迟到停止请求。

## 数据模型变更

### Sync v4 外层

现有 mutation、ACK、receive cursor、snapshot、journal 和加密契约保持不变；Server
继续只看到 opaque entity。除非实现证明现有 opaque API 无法承载，Server 不改库、
不升版本。

### `codex.command`

- 新增可选、向后可读的 `bindingGeneration`。
- 新 Gateway session 产生的命令必须携带该字段。
- worker 在执行前比较 gateway ID、session binding 和 generation；不匹配时只写
  commandResult，不调用 provider。

### `codex.commandResult`

- 新增终态 `cancelled`。
- 新增结构化 reason：`bindingSuperseded`、`threadHandoff`、`gatewayStopping`。
- 老 snapshot 缺失新字段时仍能解析。

### `codex.runtime`

- 新增可选 gateway/terminal/recovery 状态，至少覆盖：
  `starting | running | recovering | stopping | stopped` 与
  `attached | pendingDetach | detached | headless`。
- connection、execution、approval、user-input、subagent、terminal 相互独立。
- terminal detach 或 transport loss 不得把 active execution 改成 idle。

### 加密 session metadata

```ts
codexGatewayBinding: {
  gatewayId: string;
  generation: number;
  origin: "terminal" | "app";
  role: "current" | "draining" | "inactive" | "recovering";
  terminal: "attached" | "unattached";
  previousSessionId?: string;
  nextSessionId?: string;
  changedAt: number;
}
```

provider thread ID 只存在于加密 entity、加密 metadata 或受权限保护的本地控制数据。
日志只记录 HMAC 短 ID、方法名、状态、计数和错误分类。

## 实施阶段

### 1. 基线、计划和 ADR

- [x] 确认 clean `main`、基线版本和云端构建边界。
- [x] 落盘本权威计划并记录本地 memory。
- [x] 新增 ADR，记录官方 TUI、独立 worker、attach 语义、thread lease 和 handoff。
- [x] 固化旧自定义 TUI、静态 thread 绑定和 daemon 生命周期的失败边界：
      `codexCommand`、Gateway launcher/worker/coordinator、daemon discovery 和
      App Gateway manager 的 source-level 回归测试共同锁定原生委派、动态 binding、
      异常 detach 与 daemon 重发现语义。

### 2. Gateway 核心

- [x] 将 app-server process/transport ownership 从旧 `runCodex` 拆到独立 worker。
- [x] Unix 透明代理、官方 WS 鉴权和多订阅连接管理已接入；Windows 使用两个随机
      loopback WebSocket 端口，provider 端由 `0600` capability-token 文件鉴权，
      TUI 端继续使用每次 attachment 独立 bearer；launcher 会等待 worker 原子发布
      动态 control 端口，绝不回退到默认 HTTP 端口。
- [x] 实现受保护的 worker descriptor、control token、heartbeat 和 daemon discovery。
- [x] 实现 provider thread lease、generation、current/draining registry 和冲突预检。
- [x] 实现 app-server crash recovery、snapshot reconciliation 和 payload-free diagnostics。
- [x] 保留并复用 Sync v4 mapper/router/request broker；删除 selected-thread 全局假设。

组件进度（不等同于 worker 接线或端到端验收）：

- [x] 受保护 descriptor/control secret、原子状态写入、鉴权 control endpoint 和
      HMAC thread lease registry。
- [x] Unix/loopback WebSocket transport、透明 TUI proxy、独立 stable-v2 bridge client
      连接和 provider process supervisor。
- [x] provider 崩溃有限退避、bridge transport 重连和 current/draining snapshot 重订阅。
- [x] root coordinator 的 generation、事务化 handoff、child ownership、严格通知顺序、
      drain 条件与失败回滚。
- [x] root Sync v4 runtime 封装 snapshot 激活、metadata/runtime 投影、terminal 状态、
      drain/flush、权威归档与中继恢复后的退场重试。
- [x] Gateway deferred journal 持久化有序 canonical 通知和 App root handoff，截断
      尾行可恢复、raw reasoning 不入盘、超大事件降级为 snapshot 标记；Gateway seed
      确定性派生 opaque root session tag 和独立 data key。
- [x] 真实 Sync v4 runtime factory 创建确定性 E2EE root/child session，复用
      mapper/router/request broker，移除隐藏 prompt/Happy MCP，执行前校验 generation，
      root 命令交给 Gateway handoff；resume lease reservation 在已知失败时回滚、结果
      未知时保留。draining 先无阻塞判定再 flush，避免源 command 等待自身的死锁。
- [x] coordinator 支持 session ID 为空的 deferred root runtime：relay 离线时只落
      snapshot marker、canonical 通知和待决 provider request，不创建伪 session/AAD，
      也不与 TUI 竞速自动拒绝审批；恢复后原位物化、FIFO 回放并补齐 handoff 链接。
- [x] 将上述组件接入一个可恢复的 worker，并补 descriptor heartbeat、daemon discovery、
      terminal detach/attach 和 relay-offline materialization。
  - worker、heartbeat、按 attachment detach/attach、relay-offline materialization、
    descriptor exact-generation 恢复、daemon 扫描重启与健康 provider 原位接管均已接通。

### 3. CLI 原生命令面

- [x] 将 `happy codex` 参数解析改为原生委派，保留 Happy 自有 attach/stop。
- [x] terminal-origin 启动时完成 auth、daemon discovery、worker spawn、官方 TUI exec。
- [x] 实现按 attachment 轮换的一次性正常退出 nonce、异常 detach、attach picker 和
      stop picker；覆盖旧 launcher 迟到确认与新 attach 并发的回归测试。
- [x] 裸 `happy` 改为帮助与运行状态；帮助文案不再声称自定义 Codex UI。
- [x] 启动新版 daemon 时只终止经过 executable、argv、home 和 descriptor 多重验证的
      旧 Happy Codex adapter，绝不终止用户直接运行的官方 Codex 或其他 provider。
  - 候选必须来自本机 `sessions.json` 恢复出的 persisted session，而不是启动时为空的
    live-child map；发送信号前再次读取 PID argv 复核。清退只停止匹配进程，不删除
    Happy 历史或密钥记录，无法读取或任一字段不匹配时直接跳过。

### 4. Wire 与持久命令处理

- [x] 扩展 Wire schema 并补向后兼容测试；生成文件一致性继续由云端门禁验证。
- [x] CLI journal 与受保护 descriptor 持久化 binding/generation/handoff/worker lifecycle。由于 Happy
      session ID 只能由中继返回，relay 离线期间的新根线程先进入受保护的 Gateway
      deferred journal；该 journal 保存 handoff intent 和待投影的 canonical provider
      通知，中继恢复并确定性创建 session 后按原顺序回放，不能用临时 session ID
      生成无法重绑定 AAD 的 Sync v4 mutation。
- [x] 命令处理器改为每 binding 严格 FIFO；Gateway 接入阶段补执行前 generation 校验。
- [x] 已实现 cancelled reason；App 为自己发出的 command 保存本机 MMKV draft receipt，
      以官方 `UserMessage.clientId` 或 commandResult 对账。provider 已接收或结果不明确时
      删除 receipt 且绝不恢复；只有 `bindingSuperseded/threadHandoff` 明确证明未提交时，
      才把原文恢复到同 gateway 下一 generation 的草稿。目标尚未同步时保留 receipt，
      不覆盖用户已输入内容，不在其他 App 设备恢复。未得到权威结果的 receipt 不按
      时间或数量淘汰，避免长期离线与大队列静默丢失仍待裁决的草稿。

### 5. App 状态与控制

- [x] App-origin 新建和 resume 全部通过统一 Gateway manager。
  - daemon 收到现有 `spawn-happy-session` RPC 后，Codex 分支不再进入 tmux 或旧
    `happy codex --started-by daemon` 子进程。daemon 创建 `origin=app` 的 headless
    worker，等待其本机鉴权 control endpoint 就绪，再调用 stable-v2
    `thread/start` 或 `thread/resume`；control 返回已物化的 Happy session ID。
  - App-origin bootstrap 复用现有目录、模型、权限和思考等级字段，不新增中继明文
    协议。worker 用模型/权限创建或恢复官方 thread；思考等级继续由每个 App turn 的
    Sync v4 command 显式携带。
  - daemon 重启通过受保护 descriptor 和 control `status` 重新发现存活 worker，
    不依赖旧 session webhook 或 worker 是 daemon 的直接子进程。
  - headless bootstrap 使用稳定 operation ID；`thread/start|resume` 返回 provider thread
    后先把 `providerAccepted` 写入 Gateway journal，再创建 Happy binding 并写入
    `bound`。本机 control 超时或 daemon 重试只继续同一条记录，绝不重复调用非幂等
    `thread/start`。
  - 打开已绑定历史时必须复用原 Happy session ID。daemon 在现有 E2EE 校验通过后，
    只通过私有 control socket 传递该 session ID 与 32 字节独立 data key；worker 从
    中继读取并 unarchive 原 Sync v4 session，而不是用新 Gateway seed 创建重复 session。
    外部官方 thread 仍先以 App 生成的独立 data key 创建 Happy session，再由 Gateway
    接管同一 session。身份材料只允许写入 `0600` Gateway journal，不进入日志。
  - App 为一次新建意图生成 operation ID，并在目录确认、RPC 超时、daemon 重启和用户
    原参数重试时复用。该 ID 写入受保护 descriptor；launcher 先查找并恢复同一 worker，
    再重放相同 `/root/open`，不得因本机或中继响应丢失创建第二个 provider thread。
    `spawn-happy-session` 与 `resume-happy-session` 两条 App 入口必须使用同一规则，不能
    只保护新建而遗漏恢复已有 Happy session。
- [x] App Codex v4 命令从 runtime 附带当前 generation，CLI 在 provider 调用前校验。
- [x] handoff 目标处于 recovering/syncing 时禁发但保留草稿。
- [x] 展示 attached/detached/headless/recovering，并保持 execution 独立。
- [x] handoff 成功后按 gateway/generation 自动跟随，避免旧通知把页面拉回。
- [x] session 菜单加入 stop；Gateway stop 使用 machine-scoped `stop-session`，不调用旧
      adapter 的 session `killSession`。current/recovering Gateway archive 先确认 stop
      已受理再写 tombstone 和隐藏；draining/inactive 只归档目标历史，不停止新的 current
      binding。停止失败时保留可见状态并允许重试。
- [x] 更新所有 locale，设置和错误说明完整换行显示。

### 6. 删除旧交互层

- [x] 删除 Codex 自定义 Ink UI 和 raw stdin 交互层。
- [x] 删除 Happy `change_title` MCP、隐藏 `codexPrompt` 标题指令和 Codex XML system prompt。
- [x] 标题使用官方 thread name，缺失时退回官方 preview 的安全截断。
- [x] 保留 Gemini/ACP 仍使用的共享 server/MCP 基础设施；Codex-only provider
      allowlist 门禁只拒绝已删除的 Claude 活跃入口，不按 vendor 名称误删共享依赖。

### 7. 测试与云端验收

- [x] 本地仅运行 source-level Vitest/tsx/`tsc --noEmit`、翻译和静态检查。
- [x] CI 从最新 stable 官方源码构建 Codex，并保留 `0.145.0` schema drift 门禁；
      后续 PTY job 必须复用同一份已校验 provenance 的官方 artifact，禁止另装 npm
      Codex 或以 fake provider 代替验收。
- [ ] 使用 `@microsoft/tui-test@0.0.4` 驱动真实 PTY 和官方 TUI。独立 fixture 进程
      启动真实 PGlite relay、CLI 身份、Responses API 和 AppSync v4 模拟器；测试一
      通过 `happy codex --no-alt-screen` 建立 terminal-origin Gateway，测试二通过
      交互式 `happy codex attach` 恢复同一 Gateway。每次失败上传 TUI trace 与脱敏
      fixture 日志；含 token、会话密钥、Gateway capability 和数据库的临时工作目录
      必须与 Artifact 目录隔离并在结束后删除。
      首轮云端执行在 fixture 引导期发现 `tsx` 未加载该场景专用 tsconfig，导致生产
      `@/` 路径别名无法解析；启动器必须显式传入同一 tsconfig，使类型检查与运行时
      使用完全相同的解析规则。
      第二轮云端执行确认 pnpm 未在 package-local `.bin` 放置 `tui-test`；启动器必须
      使用 Node 模块解析得到官方包入口，不依赖包管理器的可执行文件布局。
      第三轮云端执行确认固定版本会递归转换整个 runner cwd，并被 CLI 根目录中指向
      未跟踪文件的旧 `.cursorrules` 链接阻断；专用 config 与测试应共同放在
      `tests/tui/`，以这个最小目录运行，避免复制无关配置和 200 MiB 以上工具归档。
      第四轮云端执行已进入真实 PTY，但 worker 早期异常会在 control server 建立前
      直接退出，descriptor 留在 `starting`；launcher 又只在 control RPC 成功后检查
      `stopped`，最终把真实错误掩盖成 20 秒通用超时。worker 必须持久化脱敏启动阶段码，
      launcher 必须先检查持久状态并在超时中携带最后状态，不以 control 存活为前提。
      早期异常还必须释放已打开的 journal 句柄与 lease，使同一 Gateway 能由恢复流程接管。
      第五轮云端执行将失败精确定位为 `startup:bridge:network`。初始 Gateway 尚无 root，
      此时 bridge 阶段唯一网络操作是连接刚启动的官方 app-server；现有 supervisor 只用
      裸 Unix TCP connect 判定就绪，首次 WebSocket 网络错误会直接终止健康 provider。
      provider socket bind 只负责确认私有端点可接受连接；真实协议 readiness 由 Happy 的
      初始化 WebSocket/RPC 连接确认。初始化前的 transient network/timeout 只允许在同一
      provider epoch 内有限重试，provider 退出或非瞬态错误立即停止。
      第六轮云端执行不再报告 `bridge:network`，但 descriptor 先被内部清理写成裸
      `stopped/unknown`，launcher 在外层阶段写入前抢读并退出。阶段码必须和首次
      `stopped` 原子写入；provider listener 可达只证明端点已经绑定，不能替代实际
      Happy client 的初始化 RPC 成功。独立探针的连接关闭也绝不能反过来成为 provider
      就绪条件。
      第七轮云端执行证明独立、未初始化的 Unix WebSocket 探针本身不能作为官方 app-server
      readiness 条件，worker 停在 `startup:provider:unknown`。该探针必须移除；保留私有
      socket listener 探测，并仅以真实 Happy client 初始化成功作为 protocol readiness。
      第八轮在同一 provider epoch 内累计 3.9 秒重试后仍稳定失败于
      `startup:bridge:network`，排除普通启动延迟。下一次产品改动前先增加独立的官方 Unix
      WebSocket 初始化门禁，只记录阶段、允许列表错误码和 stderr 字节数，判断问题属于
      app-server 传输兼容还是 Gateway 编排；不得继续用延长等待掩盖确定性失败。
- [ ] 覆盖矩阵按职责拆分，避免一个超大场景掩盖失败来源：
  - 新 PTY 门禁：terminal/App 双向消息、官方 tool/reasoning/stream、异常 PTY kill、
    十秒 detach、同 Gateway attach、同 provider PID/thread、正常退出与 v3 零回退。
  - official app-server 门禁：stable-v2 生命周期、resume/list/read、tool、reasoning
    summary、stream 与完成。
  - Android field 门禁：真实 App UI 到 relay、CLI、官方 Codex 的新建/resume、MCP
    与回复回流。
  - source/transport 门禁：new/fork、审批 first-win、active handoff/drain、queue
    restore、app-server crash、daemon restart、thread lock、多窗口、relay offline
    journal 和 10k snapshot。
- [ ] 性能门禁保持健康本地链路流式更新 p95 小于 750 ms。
- [ ] 不使用空转十分钟作为验收；长 turn 通过虚拟时钟和有实际阶段动作的生命周期验证。

### 8. 发布

- [ ] CLI 升至 `1.4.22`，App 保持 `1.11.22`，Wire 保持 `0.1.6`。
      `1.4.15` 和 `1.4.16` 的制品均成功构建安装，但发布冒烟仍断言已删除的旧帮助文案
      `Start Codex`，并且后续 removed-command 断言还存在未执行到的大小写错误；按不可
      复用已运行版本的规则推进补丁版。冒烟测试改为检查当前原生 Codex 命令面，并为
      每个失败输出独立诊断。
      `1.4.17` 发布制品已通过并下载，但真实 PTY 暴露 worker 早期失败不可诊断的产品
      缺陷；修复属于可分发 CLI 行为，因此继续推进且不复用该版本。
      `1.4.18` 发布制品也已通过并下载，阶段诊断随即证明首次官方 WebSocket 连接存在
      readiness 竞态；该产品修复继续推进到新补丁版本。
      `1.4.19` 发布制品已通过、下载并验证，但真实 PTY 继续暴露阶段错误写入顺序竞态，
      因此该已运行版本同样不复用。
      `1.4.20` 发布制品已通过；真实 PTY 证明单独 WebSocket 探针不是官方 provider
      lifecycle 的有效边界，因此切回 listener probe 并把协议重试限定在实际 client。
      `1.4.21` 提交前 CLI 单元测试 `952/952`、Gateway 聚焦测试 `25/25`、CLI 与真实
      PTY fixture 类型检查均通过；发布制品也已成功并下载验证，但真实 PTY 仍稳定报告
      `startup:bridge:network`，因此该已运行版本不得复用。
- [ ] 分阶段使用简短中文主题提交，`.agents` 和本地 Codex 文件永不暂存。
- [ ] 普通推送 `origin/main`，观察所有 Actions 并修复到全绿。
- [ ] CLI workflow 成功后下载并验证 `happy-1.4.22.tgz` 到
      `dist/release-artifacts`。
- [x] Android workflow 成功后提供 GitHub Artifact URL，不默认下载 APK。

## 本地安全边界

- 所有 control payload 使用 schema 校验和长度上限。
- capability token 与每次 attachment 的退出 nonce 使用加密随机数、常量时间比较和
  最小权限文件模式；退出 nonce 不持久化到普通 descriptor，也不得跨 attach 复用。
- 启动 provider 只使用 argv 数组，不通过 shell 拼接用户 flags、path 或 prompt。
- descriptor 写入采用临时文件、fsync、原子 rename；崩溃截断 journal 按既有规则恢复。
- kill/stop 先核对 PID start time、executable、argv marker、gateway ID 和 capability；
  PID 重用或任一证据不一致时拒绝终止。
- 不记录 prompt、reasoning、tool 参数/输出、provider ID、token 或密钥。
- 原生 HTTP 中继仍需显式可信网络 opt-in；Web 仍只允许 HTTPS/localhost。

## 验收标准

- 终端显示官方 Codex TUI，直接使用原生 resume/fork/new 和 flags。
- 终端与 App 的用户消息、assistant 内容、工具、审批和状态属于同一 provider thread，
  不重复、不乱序、不因 terminal disconnect 假结束。
- SSH 断线、TUI 被 kill、daemon 重启和 app-server 崩溃后，Gateway 状态可恢复；
  `attach` 回到原 gateway，不创建重复 provider runtime。
- thread 切换不会积累可写的旧 session；draining 数据在权威结束并 ACK 后正确归档。
- 旧 generation 命令零 provider 副作用；未提交命令可恢复为草稿。
- 已 ACK 的 Sync v4 entity 和命令在任一组件重启后零永久丢失。
- cloud official-source、PTY、CLI、App、Wire、Android field 和 release workflows 全绿。

## 明确排除

- 修改或发布官方 Codex fork。
- 同步 raw reasoning text。
- 恢复 Claude 产品路径。
- 依靠 Socket.IO 必达、超时或连接断开推断 turn 完成。
- 在本地构建 Codex、CLI release、Web、Android、Docker 或 Tauri/Cargo 制品。

## 变更记录

- 2026-08-02：根据确认的原生 TUI、持久 Gateway、attach/stop、thread handoff、
  binding generation 和云端 PTY 验收契约创建实施基线。
- 2026-08-02：完成 Gateway state/control/lease/proxy、外部 stable-v2 subscriber、
  provider supervisor 与 handoff coordinator 的组件实现；明确这些组件在 worker 和
  Sync v4 runtime 接线完成前不构成可用产品或端到端验收。
- 2026-08-02：增加 root Sync v4 runtime 生命周期封装；inactive 归档只有在 metadata、
  runtime entity 和 outbound mutation 刷新后执行，归档暂不可达时保留 draining 状态，
  允许后续通知或恢复流程重试。
- 2026-08-02：实现 Gateway deferred journal 与确定性 root session identity。离线
  handoff 不生成临时 Sync v4 AAD；恢复后使用同一 tag/data key 创建 session，并按
  journal FIFO 或权威 snapshot 标记回放。
- 2026-08-02：完成在线 Sync v4 runtime factory、逐 RPC generation guard 和 root
  reservation/handoff 接口；修复 App root 命令从源 processor 发起时 retirement flush
  等待自身的死锁。factory 在 relay 不可达时返回 deferred 信号，由 worker journal
  后续 materialize。
- 2026-08-02：将正常退出确认收紧为每次 attach 独立的 attachment ID 与一次性 nonce。
  worker 只在对应连接已进入 `pendingDetach` 后接受确认，防止旧 launcher 的迟到消息
  停止已经重新附着的 Gateway。
- 2026-08-02：增加可原位物化的 deferred root runtime。provider request 在离线期间
  保持无响应，由已附着 TUI first-win；收到 `serverRequest/resolved` 后被动结束，或在
  relay 恢复后交给真实 request broker，避免 bridge 发送错误/拒绝响应。
- 2026-08-02：接通 terminal-origin worker 与官方 `codex --remote` 命令面。worker
  组合 provider、独立 bridge、proxy、control、heartbeat、journal、lease 和恢复；
  native new/resume/fork 走 Gateway，attach 在同一 app-server 上 native resume，其他
  官方子命令直接委派。descriptor 恢复保留精确 generation，不伪造一次新 handoff。
- 2026-08-02：锁定 App-origin bootstrap 接线。复用现有 machine spawn RPC 字段，
  Codex 由 daemon 创建 headless Gateway 并通过本机鉴权 control endpoint 调用官方
  stable-v2 start/resume；Codex 不再进入 tmux 和旧 `--started-by daemon` 启动链路，
  daemon 重启以 descriptor/control 状态重新发现存活 worker。
- 2026-08-02：完成 App-origin headless start/resume、受 journal 保护的 bootstrap
  幂等恢复、原 Happy Sync v4 session 身份复用、daemon descriptor discovery 和鉴权
  stop。补齐 Windows 随机 loopback provider/TUI endpoint 与 capability-token 文件；
  删除无生产入口的旧 Ink/raw-stdin/隐藏 prompt/Codex Happy-MCP 适配链。
- 2026-08-02：审查修复正常 stop 的离线归档漏洞。正常 stop 只有在 root outbox、
  inactive metadata 与 archive 全部成功后才关闭 runtime 和释放 lease；中继离线时
  worker 保持 `stopping`、持续心跳并可由重复 stop 唤醒重试，只有 `--force` 会跳过。
  旧 Happy session 分页读取使用独立 15 秒总时限；Windows launcher 从 descriptor
  等待真实 control 端口，禁止未发布端口时误连默认端口。
- 2026-08-02：锁定 worker crash 与 App RPC 重试恢复方式。非 `stopped` descriptor
  可用同一 gateway ID 重启；journal lease 在写新 PID 前取得并以 Happy worker argv
  marker 识别 PID 重用。App 新建意图的稳定 operation ID 同时进入 machine RPC、
  descriptor 和 bootstrap journal，所有重试先找回原 worker，再继续同一 provider
  acceptance 记录。
- 2026-08-02：补充 provider orphan 恢复约束。descriptor 持久化 app-server PID；
  worker crash 后优先接管 endpoint 仍健康且 argv 与 Happy 专属 listen 地址完全匹配
  的原 provider，以保留 active turn。只有已验证 provider 不可达时才终止并重启，
  禁止直接 unlink socket 或在占用端口上盲目再起一份。
- 2026-08-02：完成 worker/daemon crash 恢复和 App 启动幂等。journal lease 先于 PID
  改写，daemon、attach 与 stop 可恢复同一 descriptor；App 新建与恢复 RPC 都携带稳定
  operation ID。provider PID 检查采用 expected/absent/unexpected/unverified 四态，存活
  但不可验证或 endpoint 被未知 owner 占用时保留现场，不 unlink、不终止、不替换。
- 2026-08-02：修复旧 adapter 清退候选表错误。新版 daemon 从本机 persisted session
  记录筛选旧 Codex adapter，核对 profile、host PID、无 Gateway binding、Happy runtime
  argv，并在 SIGTERM 前二次复核；清退不删除历史与加密材料。完整 CLI `941/941`、App
  `965/965` 源码测试及两端 TypeScript 检查通过。
- 2026-08-02：完成 App Gateway 状态与控制。composer 仅在 current generation 完成
  同步后允许发送并保留禁发期间草稿；终端与 Gateway 生命周期独立于 provider execution
  展示。handoff 只在同一 gateway 的下一 generation 校验成功后跟随。stop 改走带
  gateway/generation guard 的 machine RPC，且只允许 descriptor current binding；归档
  在 stop 受理后才隐藏。App `972/972`、CLI `947/947` 源码测试通过。
- 2026-08-02：完成 App command-draft receipt。发起设备在 command mutation 前持久化
  原草稿，以官方 `UserMessage.clientId` 和最新 commandResult 裁决；只有明确的
  `bindingSuperseded/threadHandoff` 未提交结果才恢复到严格验证的下一 generation。
  目标晚到、App 重启和 source 已移出列表均可恢复，当前输入优先且幂等合并；未知结果
  或 provider 已接收时绝不恢复。App `979/979` 源码测试与 TypeScript 检查通过。
