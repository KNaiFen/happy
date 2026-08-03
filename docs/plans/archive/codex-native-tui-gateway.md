# Codex 原生 TUI Gateway 实施计划

## 状态

- 当前状态：实施与云端验收完成，归档；后续物理设备验收转入 `.agents/open-items.md`
- 日期：2026-08-02
- 基线：`main` / `07f22cc9`
- 目标版本：CLI `1.4.32`、App `1.11.22`、Wire `0.1.6`
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
- Happy bridge 在 thread 已物化后作为 app-server 的独立订阅者；TUI 和 bridge 同时
  接收通知。独立订阅尚未 materialize 的 terminal-origin 阶段，透明代理从已认证 TUI
  上游连接镜像 stable-v2 notification 到同一 coordinator，使首轮官方 lifecycle 能被
  同步；镜像不改写或持久化原 frame，不能证明 bridge 已订阅，也不能自行结束 pending。
  coordinator 对 terminal/bridge 两个来源的同一 notification 仅在内存以有界哈希短暂去重，
  仍只以 bridge 生命周期确认订阅成功。终端根 RPC 成功响应中的官方 `Thread` 快照只在进程内短暂交给 coordinator
  激活对应 root，绝不写日志、descriptor 或第二套 mapper；不得在把该响应交给 TUI 前
  再以独立 observer 的 `thread/read` 取得同一快照。终端新建或切换的 root 随后立即建立
  一个可取消的后台协调器：它以有界指数退避安全重试 stable `thread/resume`，并在尚未订阅
  时读取权威 `thread/read` 快照补齐早期状态。协调器一直持续到订阅成功、root 被权威退休或
  worker 停止，不能依赖一次 `turn/start`/activity 通知或有限次数重试；代理 activity 只可
  加速已存在的协调器。observer 的安全 resume/read 暂时失败只能记录为 payload-free
  `observerRetry` 并继续尝试，绝不能关闭健康 TUI、取消成功根 RPC 或写成 `rootBinding`
  失败。
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
- POSIX worker 继续以 `0700/0600` Unix TUI proxy 维持私有边界。由于官方 Codex 拒绝
  将 `--remote-auth-token-env` 与 `unix://` 组合，每次 attach 的 launcher 必须在
  `127.0.0.1:0` 原子建立仅存活于该 launcher 的 WebSocket 转接器；它常量时间校验
  一次性 attachment bearer，并以同一 bearer 连接 Unix proxy。官方 TUI 只见受 bearer
  保护的 loopback `ws://`，worker descriptor 不记录该临时端口。转接器不得持久化
  token，正常退出确认完成后才关闭，异常 launcher/SSH 断开时随进程消失并触发既有 detach。
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
      WebSocket 门禁必须在两个全新的 provider 进程上分别验证握手打开与真实 Happy
      `initialize/initialized`，只记录阶段、允许列表错误码和 stderr 字节数；不得复用
      关闭过的探针连接来判断后续 client，也不得继续用延长等待掩盖确定性失败。
      第九轮在全新官方 `0.146.0` provider 上确认连接在 WebSocket `open` 事件前稳定收到
      `ECONNRESET`，provider 仍存活且产生固定长度 stderr；因此 RPC initialize、Gateway
      worker 编排和 provider 启动等待均已排除。下一门禁只允许对最多 16 KiB stderr 在内存
      中匹配官方 tungstenite 固定握手错误字符串并输出枚举分类，不得输出原文、路径或
      payload。分类前不得改用 TCP、关闭协议能力或继续扩大重试窗口。
      第十轮分类得到 `noUpgradeRejection`：stderr 中没有官方 upgrade 拒绝前缀或任何固定
      tungstenite 握手错误，不能据此认定某个 header 被拒。下一次在第三个全新 provider
      上先经 Unix stream 发送固定 RFC 6455 握手，只记录是否收到 HTTP 101 或允许列表连接
      错误；随后两个新 provider 继续分别验证 Node `ws` open 和 Happy initialize。固定
      握手成功才允许把问题归因到 Node 客户端构造，固定握手也失败则继续核对官方 listener
      构建和启动契约；两种结果都不得输出响应头、key、socket 路径或 provider stderr 原文。
      第十一轮固定 RFC 6455 请求在 `/` 路径成功返回 HTTP 101，而当前 Node `ws` 随后仍在
      `open` 前收到 `ECONNRESET`；官方 listener、Unix stream、根路径和启动时序因此排除。
      固定请求与 Node 默认握手的主要协议差异是后者声明 `permessage-deflate`。下一门禁在
      全新 provider 上使用相同 Node `ws+unix` URL、仅设置 `perMessageDeflate=false`；该
      probe 成功才把关闭扩展写入产品连接器，失败则继续比较脱敏后的请求 shape。
      第十二轮单变量 A/B 已确认：相同 Node `ws+unix` 客户端仅关闭
      `permessage-deflate` 后成功 `open`，随后默认客户端仍稳定重置。产品共用 Codex
      WebSocket 连接器必须对 Unix 和 loopback URL 都设置 `perMessageDeflate=false`，并以
      请求 header 回归锁定不发送 `Sec-WebSocket-Extensions`；无需改路径、换库、回退 TCP
      或增加重试。官方门禁保留固定 RFC、实际连接器 open 和 Happy initialize 三层定位。
      第十三轮实际 Happy connector 已通过官方 app-server lifecycle，但真实 PTY 暴露
      官方 Codex `0.146.0` 拒绝 `unix://` 远端同时传入 `--remote-auth-token-env`。
      不得为了通过测试取消 Unix proxy bearer 或把 worker endpoint 变成固定 TCP。每个
      POSIX attach 在 launcher 内以端口 0 建立受 attachment token 保护的 loopback
      `CodexGatewayProxy` 转接到已有 Unix proxy；proxy start 必须返回实际绑定 URL，且
      转接器只允许一次下游 claim、上游仍携带 token。CLI `1.4.22` 打包已经运行，修复
      必须推进到 `1.4.23`。
      第十四轮证明回环转接器已完成官方 TUI 鉴权、initialize 和首屏渲染，但首个
      `thread/start` 响应在转发给 TUI 前被 worker 关闭，当前持久诊断仅剩通用
      `Gateway transport closed`。下一次先在 root binding 内增加允许列表阶段码，至少
      区分 lease、runtime 创建、provider snapshot、runtime 激活、binding 更新和 descriptor
      同步；真实 PTY fixture 同时公开 descriptor 的脱敏 `lastError` 并在失败时落盘最终
      安全状态，避免再等待通用 120 秒超时。拿到阶段证据前不放宽“先完成持久绑定再把
      root RPC 响应交给 TUI”的一致性边界。CLI `1.4.23` 发布 workflow 已运行，后续产品
      修复必须推进到 `1.4.24`。
      第十五轮的 payload-free 诊断将失败精确定位为
      `rootBinding:providerSnapshot:protocol`。官方 Codex `0.146.0` 源码测试
      `thread_resume_rejects_unmaterialized_thread` 明确规定：`thread/start` 返回后、首条
      用户消息写入 rollout 前，`thread/resume` 必须以 `no rollout found` 拒绝。与此同时，
      官方 WebSocket app-server 在 `thread/start` 创建线程时会把所有已初始化连接自动
      订阅到新线程，因此 Happy bridge 对新根已经是合法订阅者，不得再次 resume。
      产品绑定必须按根方法区分：`thread/start` 使用稳定的
      `thread/read(includeTurns=false)` 读取 live、未物化 snapshot；真正的
      `thread/resume`、恢复绑定和可物化 history 继续通过 resume 取得完整 snapshot 与
      订阅。runtime 激活必须直接迁移 coordinator 已取得的同一份 snapshot，不得内部再
      发一次 `thread/read(includeTurns=true)`。官方 app-server 门禁新增双连接场景，证明
      第二个已初始化 bridge 在首条消息前能读取新线程、无需 resume，并能收到随后真实
      tool、reasoning summary、stream 和 `turn/completed`；PTY 首屏等待同时轮询脱敏
      `lastError`，阶段失败立即结束而不是空等 120 秒。
      第十六轮主 CI `30762251980` 否定了上述“新建广播足以保证第二连接订阅”的产品
      假设：官方双连接场景中 creator 完成真实 provider/tool 流程，但 observer 在 90 秒
      内没有收到 `turn/completed`；真实 PTY 同时记录 provider 已完成 2 次请求，Gateway
      已绑定且无 root error，但 Sync v4 的 agent/reasoning/command 投影仍全为 0。不能依赖
      app-server 内部 `thread_created` 广播作为远程连接的公开协议契约。终端
      `thread/start` 仍使用 metadata-only live snapshot 完成 fail-closed 根绑定，但标记为
      `subscriptionPending`；透明代理在同一 TUI 连接观察 `turn/start` 成功响应或首个带
      thread ID 的 provider activity 后，要求 coordinator 调用一个只在精确
      `no rollout found` 时返回“尚未物化”的 `subscribeThreadIfMaterialized`。成功后立即
      reconcile 完整 resume snapshot、释放 migration barrier 并清除 pending；失败为
      尚未物化时等待下一 activity，其他错误进入 payload-free 诊断但不得伪造完成或关闭
      健康 TUI。App 由 bridge 自己执行的 `thread/start` 保持 requester 已订阅路径；worker
      恢复时先尝试 materialized resume，未物化则 metadata read 加 pending；若随后首个
      turn 由 bridge 自己发起，bridge 收到 stable lifecycle 本身即证明 requester 订阅，
      直接清除 pending 并按原序投影，不再额外 resume 后重复应用触发该判断的同一 delta。
      官方双连接
      门禁改为验证“metadata read -> 首 turn 受理 -> materialized resume -> snapshot/后续
      lifecycle”，并继续证明 tool、reasoning summary、stream 与完成。
      第十七轮主 CI `30764098362` 证明订阅协调已生效：官方 observer 第二次探测即
      materialized resume 成功，snapshot 含首 turn，并收到 command、reasoning、agent
      stream 与 `turn/completed`；真实 PTY 也在约 5 秒内完成终端消息投影。当前失败转为
      两个独立验收问题：官方 observer 的最终 snapshot 内容断言缺少安全字段级诊断；
      PTY canary 明确定位到 Happy 本地日志。源码检查确认 CLI 入口把完整
      `process.argv` 写入日志，因而把 `happy codex <prompt>` 明文持久化。删除原始 argv
      日志，只保留允许列表 command family 与参数数量；官方 observer 记录 item type、
      command/reasoning/agent 字节数，不输出内容并继续保留完整性断言。CLI `1.4.25` 已
      发布不可复用，修复推进到 `1.4.26`。
      完整 CLI 并发套件同时暴露 PTY worker 测试替身早于真实 `proxy.start()` 暴露
      root hooks，导致测试可在 runtime factory 初始化前伪造一个生产中不可达的请求，
      并在失败后提前删除临时目录。测试替身改为仅在 `start()` 时公开 hooks，保持与
      真实监听边界一致；该修正不改变 Gateway 产品时序。
      第十八轮主 CI `30764952285` 的安全计数证明 latest stable `0.146.0` 最终
      `thread/read` snapshot 含 `userMessage`、`reasoning` 和 `agentMessage`，但不含已经
      完成的 `commandExecution`；同一 observer 的 live methods 明确包含 command output、
      reasoning summary 和 agent delta。官方 snapshot 门禁因此分别验证三类 live stream，
      最终 snapshot 只验证官方实际持久化的 reasoning/assistant 内容；工具输出的历史恢复
      继续由首轮 PTY 中已经通过的 Happy Sync v4 持久 entity 断言负责。
      同轮 PTY 首轮完整通过，attach 也恢复同一 Gateway/provider/thread/session；trace
      显示测试在官方 TUI 首屏出现后约 2 ms 即把整段 prompt 与回车写入同一 PTY chunk，
      文本已进入 composer，但初始化期吞掉回车，provider 请求数未增加。attach 测试改为
      先写文本并等待 composer 确认渲染，再单独提交回车，模拟真实用户输入边界。两项均为
      验收修正，不改变可分发代码，也不再推进 `1.4.26` 版本。
      第十九轮主 CI `30765576825` 证明上述两项修正有效：fresh observer 全部通过，attach
      二次 provider round trip 也完成。主 lifecycle 随后失败是因为它与 fresh observer
      共用同一个有状态 Responses fixture，前者已经消费唯一的首轮 shell call，后者实际
      直接回复却仍断言 command lifecycle；两个官方场景改用独立 fixture/config，防止工具
      状态跨 provider 场景污染。
      PTY 最终安全状态同时证明 descriptor 已 `stopped`、provider 已退出、Happy session
      已 inactive、所有消息已投影且无泄漏，但专用 worker PID 在 45 秒后仍存活。worker
      函数已经等待 proxy、coordinator/Sync v4 session、provider、control、journal 和原子
      descriptor 清理；隐藏 worker 入口不得再依赖 Node 事件循环碰巧清空，完成后显式以
      0 退出。该项改变已安装 CLI 的进程生命周期，发布目标推进到 `1.4.27`。
- [ ] 覆盖矩阵按职责拆分，避免一个超大场景掩盖失败来源：
  - 新 PTY 门禁：terminal/App 双向消息、官方 tool/reasoning/stream、异常 PTY kill、
    十秒 detach、同 Gateway attach、同 provider PID/thread、正常退出与 v3 零回退。
  - official app-server 门禁：stable-v2 生命周期、resume/list/read、tool、reasoning
    summary、stream 与完成；另以两个真实 WebSocket 连接验证未物化新线程的
    metadata-only read、首 turn 后 stable resume、完整 snapshot 和后续通知回流。
  - Android field 门禁：真实 App UI 到 relay、CLI、官方 Codex 的新建/resume、MCP
    与回复回流。
  - source/transport 门禁：new/fork、审批 first-win、active handoff/drain、queue
    restore、app-server crash、daemon restart、thread lock、多窗口、relay offline
    journal 和 10k snapshot。
  - 第二十轮 Android field `30766338317` 已确认 APK 打包、零机器 bootstrap、历史
    resume 与首条普通回复均通过；失败只发生在等待 `codex-mcp-tool-message`。现场诊断
    显示官方 `0.146.0` 暴露了 5 个动态工具命名空间，但 `Happy MCP` offer、调用和结果
    均为 0。这符合本计划已经删除 Codex 专用 Happy MCP 注入的产品边界，不能为修复
    测试而恢复隐藏生产 MCP 或 prompt。Android fixture 改为仅在其临时 `CODEX_HOME`
    `config.toml` 配置独立、无业务副作用的 stdio 测试 MCP；Responses fixture 保持 seed
    turn 使用普通 shell，随后经官方动态 tool-search 选择该测试 MCP。验收改为确认
    官方 `mcpToolCall`、Sync v4 entity、App 单卡投影和 MCP output 均出现，同时不再把
    测试专用 server 名称或 Happy 工具名写入产品代码。该修正仅影响 CI fixture/测试，不
    改变已发布 CLI `1.4.27`、App `1.11.22` 或 Wire `0.1.6`。
  - 第二十一轮 Android field `30768549595` 已通过零机器、历史 resume、App 到官方
    `0.146.0` 的动态 tool-search、测试 MCP call/output、Sync v4 单卡投影、首条回复和
    `/compact`；诊断为 `5` 个 provider request、`1` 次 namespace/tool-search/MCP call
    与 MCP output，v3 消息为 `0`。失败只在进程死亡后的 recovery 脚本：field flow 先
    `home` 再 kill，重启后 App 正确显示持久化会话列表，旧脚本却未打开 `New chat` 就直接
    查找已折叠工具输出。恢复验收须先重新进入该会话，以 `codex-mcp-tool-message` 验证持久
    工具卡、点击详情验证精确 output，再返回聊天验证历史与回复；这避免把合理的首页恢复
    行为误报为 Sync v4 丢失，且只改 CI test。
  - 第二十二轮主 CI `30770367349` 的普通矩阵和官方 app-server lifecycle 全绿，但
    真实 PTY 中终端已完成 `2` 次 provider request 并显示回复，Happy projection 仍为
    ready 且 agent/reasoning/command/response 全部为 `0`，无 root error。现有代理只在
    `turn/start` 成功响应或 provider activity 到达时立即调用 stable
    `thread/resume`；若这些事件都先于 rollout 持久化完成，所有调用均返回精确的
    unmaterialized，最后一条事件后再无触发源，形成时序相关的永久漏订阅。worker 必须
    对“已观察到 activity 且仍 subscription-pending”的 thread 启动不阻塞 TUI 转发的
    后台有限退避对账；只重试可安全重复的 stable resume/read，成功后 reconcile 权威
    snapshot 并清除诊断，心跳只为仍有 activity 证据的 pending thread 低频续接。
    handoff 后仍受 Gateway 管理的 draining root 继续对账，`subscriptionPending` 必须
    阻止 runtime 因尚未投影任何 turn 而被误判为 drained 并提前退休；只有完成订阅并
    权威确认排空后才能退休。root 退休、stop 与 worker cleanup 必须终止后续尝试。该项
    改变可分发 CLI 行为，目标
    推进到 `1.4.28`，App/Wire/Server 保持不变。
  - 第二十三轮主 CI `30771396112` 证明第二十二轮的有限退避本身不足：官方 TUI
    trace 显示终端 prompt、工具输出和最终回复均已完成，Gateway/provider 均存活、无
    root error，但 Sync v4 的 agent/reasoning/command/response 均为 `0`。这表明官方
    `thread/started` 或第一条 activity 可以早于透明代理完成 `rootBound`；当时该 root
    尚未进入 `subscriptionPending`，worker 抛弃 activity 证据，后续 root 绑定后没有
    新事件可唤醒退避。worker 必须有界缓存早到 activity，并在每次 root bind / pending
    集合刷新后为已有证据的 pending root 立即启动后台对账；已绑定但不再 pending 的
    证据应清除，未知早到 ID 需有容量上限而不是依赖短超时丢弃。新增回归必须精确模拟
    “activity 在 rootBound 前、rollout 在首次 stable resume 后才可用”，且不发送第二条
    activity。`1.4.28` release `30771395978` 已完成并下载验证，不可复用；目标推进到
    `1.4.29`，App/Wire/Server 保持不变。
  - 第二十四轮主 CI `30772327426` 证明早到 activity 缓存仍不能作为正确性前提：官方
    PTY trace 在约 3.5 秒内完成 prompt、shell tool 和最终回复，Gateway/provider 保持
    running、无 root error，但投影仍为零；同一运行中的独立官方 observer 验收已证明
    stable-v2 `thread/resume` 在首 turn 开始后可订阅。因此不能再把漏订阅的恢复寄托于
    某条代理 activity 是否被解析。此项取代第二十二、二十三轮的 activity 缓存和有限
    retry 设计；每个 `deferredNewThread` root 在成功根 RPC 后必须
    无条件启动一个单一、可取消的协调任务；任务在 root 仍 pending 时持续以有界指数
    退避尝试 safe resume，并在未订阅时以 `thread/read` 完整快照重协调已有历史。成功
    resume 后才清除 pending；root 被退休或 worker stop 时终止任务。停止时必须先持久化
    `stopping` descriptor；既有的权威 interrupt 协调结束后，再主动断开 Gateway 自己的
    observer transport，最后才等待 coordinator 的 lifecycle/stop lock；这样卡住的安全
    resume/read RPC 会被拒绝并释放 root lock。这只把该 RPC 标记为结果未知，绝不能推断
    turn 已结束，也不得把预期的 shutdown cancellation 覆盖成持久 `rootBinding` 错误。
    activity 只用于立即唤醒既有任务，不再决定任务是否存在。新增测试
    必须覆盖“根绑定后没有任何可识别 activity、超过旧六次有限重试后才 materialize”、
    pending snapshot reconcile 不会把 root 误标为已订阅，以及 stop 发生在 resume RPC
    无响应时仍能完成清理。这个变化只改 CLI，`1.4.29` release
    `30772327334` 已通过并下载验证，版本不可复用，目标推进到 `1.4.30`。
  - 第二十五轮主 CI `30773936190` 的真实 PTY 证明根 RPC 已成功返回后，worker 仍在
    把响应转发给 TUI 前对独立 observer 执行 `thread/read`，官方 stable-v2 源码明确该
    读取可暂时以 `thread not loaded` 拒绝，导致错误地持久化
    `rootBinding:providerSnapshot:protocol` 并关闭健康 TUI。根响应本身已经携带权威
    `Thread` snapshot，代理必须只在内存把它交给 coordinator，terminal start/resume/fork
    一律进入 observer-pending 状态；observer 后续单独订阅。所有后台 observer
    subscribe/read 异常都必须先尝试 snapshot reconcile、限频记录为非致命
    `observerRetry:<kind>`，且只在实际订阅成功后清除，不得触发 PTY 的 root-binding
    快速失败。新增 proxy 原样转发+snapshot、coordinator 免二次读取、worker observer
    异常不致命三类回归。`1.4.30` release `30773936092` 已成功并下载验证，版本不可
    复用，目标推进到 `1.4.31`。
  - 第二十六轮 Android field `30773936210` 再次证明主路径和 server-side 诊断均已完成：
    `5` 次 provider request、动态 tool-search、测试 MCP call/output、单卡、回复和 compact
    均通过，失败截图也展示了重启后工具详情的完整 JSON output。失败原因是 Maestro 将该 JSON
    作为一个含换行的原子 accessibility text，而 recovery 断言将 marker 当作整个文本节点
    匹配。恢复门禁改为 DOTALL 全文本正则，仍要求 marker 出现在可见的持久 output 中，不能仅以
    工具卡存在或服务端诊断代替；这只修正测试选择器，不改变 App 或协议行为。
  - 第二十七轮 CLI `1.4.31` 的 release `30775583482` 已成功，但主 CI
    `30775583548` 的真实 PTY 仍证明 terminal 已完成真实官方回复，而 descriptor 保持
    `observerRetry:protocol`、App projection 的 agent/reasoning/tool/response 计数全为 0。
    这表明不能把 terminal-origin 首轮同步建立在第二连接的 `thread/resume` 先成功之上：
    官方 stable-v2 对刚由 TUI 创建的 live thread 允许该 observer 暂时不可恢复。修复应让
    透明 proxy 把它已收到的 stable-v2 notification 原样、按上游顺序交给 coordinator；
    terminal 来源只投影和唤醒 observer，绝不清除 `subscriptionPending`。bridge 后续真正
    收到同一 lifecycle 时才清除 pending，两个来源的等价 notification 通过仅内存、容量和
    TTL 均受限的摘要去重，避免重复 delta/工具卡。根响应 snapshot 同时仅在 bridge client
    内注册为当前 thread，令带显式 `threadId` 的 App turn 在独立 resume 尚未完成时可以按
    stable-v2 直达已运行 thread；真实 PTY 门禁必须验证这一轮 App -> provider -> terminal/
    App 回流。任何 proxy 镜像或 App command 失败都不得关闭 TUI。另一个独立 CI 失败发生在
    官方 lifecycle 业务断言已通过后的临时 `CODEX_HOME` 删除，Codex 的插件 clone 尚在收尾，
    所以测试 cleanup 仅针对 `ENOTEMPTY`/`EBUSY`/`EPERM` 做有界重试，不能吞掉其它错误或
    改变产品运行时。`1.4.31` 已运行不可复用，目标推进到 `1.4.32`。
  - 第二十八轮已实现并完成源码级验证：transparent proxy 只对不带 JSON-RPC `id` 的
    stable-v2 provider notification 建立解析镜像，并始终原样转发原 frame 给 TUI；镜像
    callback 仅排入 coordinator 队列，任何投影异常只走既有 payload-free 诊断，不能阻塞
    或关闭终端。coordinator 为 terminal/bridge 标记来源：terminal 生命周期可以在 observer
    仍 pending 时投影，bridge 生命周期才清除 pending；同一跨来源 notification 只以 15 秒、
    4096 条容量受限的内存 SHA-256 摘要去重，同来源重复不丢弃。提前到达的 bridge 通知也
    必须在 terminal root 绑定前保留其订阅证明。成功 terminal root response 的快照只在
    bridge client 内存注册为 selected thread，不发 RPC、不发第二个 lifecycle、不持久化，
    从而让 App 使用 stable `turn/start.threadId` 直达该 thread。官方 lifecycle fixture 的
    临时根目录 cleanup 仅对 `ENOTEMPTY`、`EBUSY`、`EPERM` 进行最多六次有界重试。新增
    proxy、coordinator、client、worker 回归后，CLI TypeScript、PTY fixture TypeScript、
    聚焦 `104/104` 和全量 CLI unit `110` 文件、`982` 项均通过；尚待 `1.4.32` 云端的
    最新 stable 官方 app-server lifecycle、真实 TUI 往返、release archive、Android field
    与 aggregate gate 验收。
  - 第二十九轮最终云端验收全部通过：CLI release `30777321964`、主 CI `30777322112` 和
    Android API 36 field `30777322086` 均为 success。主 CI 使用最新 stable 官方 Codex
    source，官方 lifecycle 和真实 PTY 的 terminal/App、detach/attach、normal stop 往返均
    成功；Android field 也完成真实 relay、官方 Codex、App、MCP 与恢复场景。已下载并验证
    `happy-1.4.32.tgz`（SHA-256
    `9d0d6f4f07046c16b935ba0579ce666ef24fd2a606ebd6724744f8a384f999dd`），包含 macOS
    ARM64 的 `ripgrep` 与 `difftastic` 归档。实现计划至此完成，物理 SSH/设备验收另列
    本机 open item。
- [x] 性能门禁保持健康本地链路流式更新 p95 小于 750 ms：主 CI 的真实 Happy relay
      scenario 对该阈值进行硬性断言并已通过。
- [x] 不使用空转十分钟作为验收；长 turn 通过虚拟时钟和有实际阶段动作的生命周期验证。

### 8. 发布

- [x] CLI 升至 `1.4.32`，App 保持 `1.11.22`，Wire 保持 `0.1.6`。
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
      `1.4.22` 的 package validation/build 已通过，实际 official app-server lifecycle
      也已通过，证明压缩协商修复有效；但真实 PTY 因官方拒绝 Unix remote 的 token 参数
      失败，因此这个已运行版本同样不得复用。
      `1.4.23` package workflow 已通过，真实 PTY 也已确认官方 TUI 可经一次性 bearer
      回环转接器完成鉴权、initialize 和渲染；首个 `thread/start` 在 worker 的持久 root
      binding 阶段失败。该已运行版本不得复用，最终修复推进到 `1.4.24`。
      `1.4.24` package workflow 已通过并下载验证，但主 CI 的真实双连接与 PTY 均证明
      第二个初始化连接未收到新线程首 turn 生命周期；该已运行版本不得复用，正式订阅
      协调修复推进到 `1.4.25`。
      `1.4.25` package workflow 已通过并下载验证，真实 observer 与 PTY 已证明首轮
      订阅和投影恢复；PTY 同时定位到 CLI 入口原始 argv 日志泄漏。该已运行版本不得
      复用，日志修复与 snapshot 安全诊断推进到 `1.4.26`。
      `1.4.26` package workflow `30764952183` 已通过，制品已下载并验证；后续只修正
      云端验收与计划。第十九轮 PTY 随后定位到专用 worker 完成清理后不退出的分发行为
      缺陷；`1.4.26` 已运行不可复用，最终目标推进到 `1.4.27`。
      `1.4.27` release `30766338252` 与主 CI `30766338313` 已通过并下载验证；后续
      `30770367349` 暴露 terminal 新线程在 rollout 持久化前耗尽 activity-triggered
      resume 的竞态。该修复改变 Gateway 自动恢复行为，`1.4.27` 已运行不可复用，目标
      推进到 `1.4.28`。
      `1.4.28` release `30771395978` 已通过、制品已下载验证，但真实 PTY `30771396112`
      暴露 early activity 在 root bind 前被丢弃的竞态；该已运行版本不得复用，目标推进到
      `1.4.29`。
      `1.4.29` release `30772327334` 已通过、制品已下载验证，但主 CI
      `30772327426` 的真实 PTY 仍零投影，证明 activity 缓存与短有限重试不能构成
      订阅正确性保证；该已运行版本不得复用，目标推进到 `1.4.30`。
      `1.4.30` release `30773936092` 已通过并下载验证，但真实 PTY
      `30773936190` 暴露了成功根响应被 observer 二次读取抢占的协议竞态；该已运行版本
      不得复用，目标推进到 `1.4.31`。
      `1.4.31` release `30775583482` 已通过；main CI `30775583548` 的 terminal TUI
      已得到官方回复而 App 仍零投影，且 lifecycle 场景仅因测试临时目录 `ENOTEMPTY` 收尾失败。
      两项修复均改变可分发 Gateway/CI 验收行为，已运行版本不得复用，目标推进到 `1.4.32`。
- [x] 分阶段使用简短中文主题提交，`.agents` 和本地 Codex 文件永不暂存。
- [x] 普通推送 `origin/main`，观察所有 Actions 并修复到全绿。
- [x] CLI workflow 成功后下载并验证 `happy-1.4.32.tgz` 到
      `dist/release-artifacts`。
- [x] Android workflow 成功；Artifact
      `https://github.com/KNaiFen/happy/actions/runs/30777322086/artifacts/8842850317`
      已解析，不默认下载 APK。

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
- 2026-08-02：真实官方 Unix 诊断在独立 provider 上将失败收敛到 WebSocket 握手本身：
  Happy 客户端尚未触发 `open` 就收到 `ECONNRESET`，provider 未退出。下一步仅通过
  tungstenite 固定错误白名单分类握手拒绝原因，在拿到分类证据前不改变产品传输架构。
- 2026-08-02：官方 stderr 白名单分类返回 `noUpgradeRejection`，没有证据支持缺失或错误
  WebSocket header。验收增加一个全新 provider 的固定 RFC 6455 握手对照，仅比较 HTTP
  101，再与 Node `ws` 和 Happy initialize 的独立 provider 结果交叉定位。
- 2026-08-02：固定 RFC 6455 Unix 握手在 `/` 上返回 101，当前 Node `ws` 则稳定重置；
  下一步用独立 provider 只关闭 Node 默认的 `permessage-deflate` 扩展，验证这一单变量。
- 2026-08-02：单变量云端 A/B 证明 `permessage-deflate` 声明导致官方 `0.146.0`
  listener 重置连接。Unix 与 loopback 共用连接器统一禁用压缩协商，并补 header 回归；
  产品修复推进 CLI `1.4.22`。
- 2026-08-02：`1.4.22` 真实官方 lifecycle 已通过，但官方 TUI 明确拒绝
  `--remote-auth-token-env` 与 `unix://` 组合。保留 worker 的私有 Unix proxy，改由每次
  POSIX launcher attach 创建随机 loopback、一次性 bearer 鉴权的转接器，转接到 Unix
  upstream；不持久化临时端口或 token。由于 `1.4.22` 发布 workflow 已运行，目标推进
  `1.4.23`。
- 2026-08-02：`1.4.23` 回环转接器已让官方 TUI 完成鉴权、initialize 和首屏渲染；
  真实 PTY 随后在首个 `thread/start` 的 worker root binding 阶段收到通用 transport close。
  先补 payload-free 分阶段诊断和失败状态 artifact，再依据云端证据修复；目标推进
  `1.4.24`。
- 2026-08-02：主 CI `30761151549` 将根绑定失败精确分类为
  `providerSnapshot:protocol`。官方 `0.146.0` 源码确认未物化新线程不能 resume，同时
  app-server 会把所有已初始化连接自动订阅到新建线程。新线程绑定改为 metadata-only
  live read，并把同一 snapshot 直接交给 runtime 迁移；恢复/真实 resume 仍使用完整
  resume。新增官方双连接验收和 PTY 阶段快速失败。
- 2026-08-02：主 CI `30762251980` 证明远程 WebSocket 第二连接不能依赖内部新线程
  广播获得首 turn 通知。保留 metadata-only 根绑定，新增 `subscriptionPending` 与代理
  观察到 materialization 边界后的稳定 resume/reconcile；不复制 raw provider payload，
  不改变 TUI 连接。`1.4.24` 已发布不可复用，目标推进 `1.4.25`。
- 2026-08-02：主 CI `30764098362` 证明 materialized stable resume 和真实 PTY 首轮
  投影均已成功；失败转为完整 argv 被 Happy 启动日志持久化，以及 observer snapshot
  断言缺少字段级安全诊断。移除原始 argv 日志，保留允许列表 invocation metadata；
  增加仅含 item 类型和字节计数的 snapshot 诊断。`1.4.25` 已发布不可复用，目标推进
  `1.4.26`。
- 2026-08-02：修正 worker 测试替身的 proxy 可用边界。hooks 只在 mock `start()` 后
  暴露，与真实 listener 一致，避免完整并发套件在 worker 尚未 ready 时注入不可能发生
  的 root 请求并把后续异步清理误报为产品竞态。
- 2026-08-02：主 CI `30764952285` 证明官方完整 snapshot 不保留已完成 command item，
  而 live observer 和 Happy Sync v4 已分别覆盖命令流与持久恢复；删除错误的官方工具
  snapshot 断言并把三类 live method 改为逐项要求。真实 PTY trace 同时证明 attach prompt
  的原子文本+回车发生在 TUI 首屏后约 2 ms，改为渲染确认后的独立回车。两项均不修改
  产品代码，CLI 保持已发布并验证的 `1.4.26`。
- 2026-08-02：主 CI `30765576825` 证明 observer 与 attach round trip 已通过。将两个
  official-source 场景的有状态 Responses fixture 完全隔离；同时保留正常 stop 的严格
  worker-PID 门禁，因为安全 artifact 证明业务清理已完成但专用 worker 仍不退出。隐藏
  worker 入口在所有 awaited cleanup 后显式成功退出，产品修复推进 CLI `1.4.27`。
- 2026-08-02：主 CI `30772327426` 的官方 PTY 再次证明 terminal thread 的 observer
  订阅不能以代理 activity 或六次短退避作为存活条件。改为根 RPC 成功即启动可取消的
  持续 resume/snapshot 协调；它只在权威订阅、root retirement 或 worker stop 时结束，
  保持不依赖时间推断 turn 完成的边界。worker stop 会先持久化 lifecycle，再在等待
  coordinator lock 前于 interrupt 协调后关闭 observer transport，解除可能持有 root lock
  的安全读/订阅 RPC，但不把该取消解释为 turn 完成或持久 rootBinding 失败。
  该分发行为修复推进 CLI `1.4.30`。
- 2026-08-03：主 CI `30773936190` 证明首个 terminal root 响应虽已成功，但 worker 在
  转发它前从独立 observer 重读 thread，官方 `thread/read` 的暂时 `thread not loaded`
  边界被错误升级为 root binding 失败。改为仅在内存复用成功根响应的 stable-v2 snapshot
  激活 root，并把 observer 的后续订阅/read 失败隔离为可重试、payload-free 的
  `observerRetry`；不改变 TUI 透明转发、不写 provider payload、不推断 turn 完成。
