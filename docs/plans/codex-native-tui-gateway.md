# Codex 原生 TUI Gateway 实施计划

## 状态

- 当前状态：实施中
- 日期：2026-08-02
- 基线：`main` / `4cce2cb4`
- 目标版本：CLI `1.4.15`、App `1.11.22`、Wire `0.1.6`
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
- app-server 崩溃时 worker 有限退避重启，重新订阅 current 和 draining thread，
  读取权威 snapshot；未知的非幂等 RPC 不自动重放。
- POSIX 使用私有目录和 Unix socket，目录与 socket 权限为 `0700`；Windows 使用
  loopback WebSocket 和随机 capability token。控制令牌与状态文件为 `0600`，
  daemon 控制接口也必须鉴权。

### 终端断开与重新附着

- TUI 连接消失后进入 10 秒 `pendingDetach`，等待 launcher 的一次性正常退出确认。
- 收到匹配 lease nonce 的正常退出确认时：terminal-origin Gateway 停止，Happy
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
- [ ] 固化当前自定义 TUI、静态 thread 绑定和 daemon 生命周期的失败测试。

### 2. Gateway 核心

- [ ] 将 app-server process/transport ownership 从旧 `runCodex` 拆到独立 worker。
- [ ] 实现 Unix/loopback 透明代理、官方 WS 鉴权和多订阅连接管理。
- [ ] 实现受保护的 worker descriptor、control token、heartbeat 和 daemon discovery。
- [ ] 实现 provider thread lease、generation、current/draining registry 和冲突预检。
- [ ] 实现 app-server crash recovery、snapshot reconciliation 和 payload-free diagnostics。
- [ ] 保留并复用 Sync v4 mapper/router/request broker；删除 selected-thread 全局假设。

组件进度（不等同于 worker 接线或端到端验收）：

- [x] 受保护 descriptor/control secret、原子状态写入、鉴权 control endpoint 和
      HMAC thread lease registry。
- [x] Unix/loopback WebSocket transport、透明 TUI proxy、独立 stable-v2 bridge client
      连接和 provider process supervisor。
- [x] provider 崩溃有限退避、bridge transport 重连和 current/draining snapshot 重订阅。
- [x] root coordinator 的 generation、事务化 handoff、child ownership、严格通知顺序、
      drain 条件与失败回滚。
- [ ] 将上述组件接入一个可恢复的 worker，并补 descriptor heartbeat、daemon discovery、
      terminal detach/attach 和真实 Sync v4 runtime factory。

### 3. CLI 原生命令面

- [ ] 将 `happy codex` 参数解析改为原生委派，保留 Happy 自有 attach/stop。
- [ ] terminal-origin 启动时完成 auth、daemon discovery、worker spawn、官方 TUI exec。
- [ ] 实现正常退出 nonce、异常 detach、attach picker 和 stop picker。
- [ ] 裸 `happy` 改为帮助与运行状态；帮助文案不再声称自定义 Codex UI。
- [ ] 启动新版 daemon 时只终止经过 executable、argv、home 和 descriptor 多重验证的
      旧 Happy Codex adapter，绝不终止用户直接运行的官方 Codex 或其他 provider。

### 4. Wire 与持久命令处理

- [x] 扩展 Wire schema 并补向后兼容测试；生成文件一致性继续由云端门禁验证。
- [ ] CLI journal 持久化 binding/generation/handoff/worker lifecycle。
- [x] 命令处理器改为每 binding 严格 FIFO；Gateway 接入阶段补执行前 generation 校验。
- [ ] 已实现 cancelled reason；仍需完成草稿恢复和 accepted command 对账。

### 5. App 状态与控制

- [ ] App-origin 新建和 resume 全部通过统一 Gateway manager。
- [ ] App 命令附带当前 generation；同步期间禁发但保留草稿。
- [ ] 展示 attached/detached/headless/recovering，并保持 execution 独立。
- [ ] handoff 成功后按 gateway/generation 自动跟随，避免旧通知把页面拉回。
- [ ] session 菜单加入 stop；archive 先 stop 后隐藏。
- [ ] 更新所有 locale，设置和错误说明完整换行显示。

### 6. 删除旧交互层

- [ ] 删除 Codex 自定义 Ink UI 和 raw stdin 交互层。
- [ ] 删除 Happy `change_title` MCP、隐藏 `codexPrompt` 标题指令和 Codex XML system prompt。
- [ ] 标题使用官方 thread name，缺失时退回第一条真实用户消息的安全截断。
- [ ] 保留 Gemini/ACP 仍使用的共享 server/MCP 基础设施，不以名称误删。

### 7. 测试与云端验收

- [ ] 本地仅运行 source-level Vitest/tsx/`tsc --noEmit`、翻译和静态检查。
- [ ] CI 从最新 stable 官方源码构建 Codex，并保留 `0.145.0` schema drift 门禁。
- [ ] 使用 `@microsoft/tui-test` 驱动真实 PTY 和官方 TUI，Responses fixture 提供
      无 OpenAI 凭据的真实 app-server 生命周期。
- [ ] 覆盖 terminal/App 双向消息、resume/new/fork、tool/MCP/reasoning、审批 first-win、
      active handoff/drain、queue restore、SSH/kill detach+attach、app-server crash、
      daemon restart、thread lock、多窗口、relay offline journal 和 10k snapshot。
- [ ] 性能门禁保持健康本地链路流式更新 p95 小于 750 ms。
- [ ] 不使用空转十分钟作为验收；长 turn 通过虚拟时钟和有实际阶段动作的生命周期验证。

### 8. 发布

- [ ] CLI 升至 `1.4.15`，App 升至 `1.11.22`，Wire 升至 `0.1.6`。
- [ ] 分阶段使用简短中文主题提交，`.agents` 和本地 Codex 文件永不暂存。
- [ ] 普通推送 `origin/main`，观察所有 Actions 并修复到全绿。
- [ ] CLI workflow 成功后下载并验证 `happy-1.4.15.tgz` 到
      `dist/release-artifacts`。
- [ ] Android workflow 成功后提供 GitHub Artifact URL，不默认下载 APK。

## 本地安全边界

- 所有 control payload 使用 schema 校验和长度上限。
- capability token 使用加密随机数、常量时间比较和最小权限文件模式。
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
