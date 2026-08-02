# ADR-004: 通过持久 Gateway 运行官方 Codex TUI

## 状态

Accepted

## 日期

2026-08-02

## 背景

旧 Codex 入口由 Happy 自己启动 stdio app-server、维护 selected thread，并使用 Ink
渲染一套简化终端界面。同一个前台进程还持有 Happy session、Sync v4 bridge、命令
队列和 provider 生命周期。该结构有四个不可局部修补的问题：

- Happy UI 无法持续跟进官方 Codex TUI 的原生命令、选择器和交互行为。
- TUI、app-server 和 Sync bridge 共用前台进程生命周期，SSH 或终端异常断开会同时
  丢失远程控制路径。
- 原生 `/resume`、`/new`、`/fork` 改变 provider thread 后，静态 root binding 无法
  安全切换 Happy session，延迟命令也可能落入新 thread。
- daemon 进程的环境不等于用户当前终端环境；由 daemon 代替终端启动所有 provider
  会丢失 profile、临时环境和原生 Codex 配置语义。

官方 Codex 提供 `codex --remote` 与多客户端 app-server transport。stable-v2 的
`thread/unsubscribe` 只移除订阅者，不会停止仍有其他订阅者的 provider turn，因此
可以让 Happy bridge 在 TUI 消失后继续持有 thread。

## 决策

### 官方 TUI

交互式 `happy codex` 只启动官方 Codex TUI，并让它通过受控本地 remote endpoint
连接 Gateway。Happy 不 fork、不 patch、不重新实现 TUI。

非交互官方子命令透明委派给 `codex`，不创建 Happy session。Happy 只保留自己的
`attach` 和 `stop` 控制命令。

### 独立 worker

每个交互窗口对应一个脱离终端生命周期的 Gateway worker。worker 持有：

- 一个官方 app-server；
- 一个只做 JSON-RPC 透传、根 thread 预检和成功结果观察的 TUI proxy；
- 一个独立 stable-v2 Happy subscriber；
- Sync v4 bindings、持久 journal、thread leases 和 crash recovery；
- 带 capability token 的本地 control endpoint、descriptor 和 heartbeat。

terminal-origin worker 由前台 launcher 继承当前终端环境后脱离启动，再向 daemon
注册。App-origin worker 由 daemon 以 daemon/profile 环境启动。daemon 重启只重新
发现 worker，不接管或重建仍存活的 app-server。

### 终端退出与 attach

官方 TUI 的正常退出和输入流异常关闭最终都会取消订阅，provider 协议本身不足以
区分二者。launcher 因此持有一次性 nonce，并只在官方 TUI 正常返回后向 worker
确认。连接关闭后 worker 等待 10 秒：

- nonce 确认成功时，terminal-origin worker 正常停止；App-origin worker 回到 headless；
- 没有确认时，worker 进入 `terminalDetached`，保留 app-server、turn、bridge 和 App
  控制能力。

新的 TUI 进程没有旧 UI 内存，所以 attach 必须对同一个 app-server 调用一次官方
`thread/resume` 来重建历史和订阅。这不是新建 provider runtime，也不得重放已有
turn。Happy 禁止用第二个 app-server 执行 attach。

### Thread lease 与 generation

同一 provider thread 同时只允许一个 Gateway 持有。resume 在发给 provider 前检查
HMAC thread lease；冲突保持当前 TUI binding 不变。start/fork 得到新 thread ID 后
原子建立 lease。

每次成功 root handoff 都递增 `bindingGeneration`。App 命令必须携带当前 generation；
worker 在 provider 调用前拒绝过期命令。源 binding 进入 draining，直到权威 turn
状态、命令对账和 Sync v4 ACK 全部完成后才归档和释放 lease。

### 安全与隐私

- POSIX 私有目录和 Unix socket 使用 `0700`；控制文件使用 `0600`。
- Windows 使用 loopback WebSocket 和随机 capability token。
- descriptor、PID 和 kill 操作必须校验 gateway identity 与进程证据，防止 PID 重用。
- 用户 flags 通过 argv 数组传递，不经过 shell。
- 日志不记录 prompt、reasoning、tool payload、provider ID、bearer token 或密钥。
- stable-v2 与最低 Codex `0.145.0` 保持不变；只同步 reasoning summary。

## 替代方案

### 继续维护 Happy Ink UI

拒绝。它必须持续复制官方 TUI 行为，且不能解决前台进程生命周期和原生 thread
切换问题。

### 每次 App 或终端连接启动独立 app-server

拒绝。同一 provider thread 会出现多个不协调的订阅、审批和写入路径，无法提供
first-response-wins、准确 execution 状态或 thread 独占。

### 由 daemon 启动所有 Gateway

拒绝。terminal-origin 会继承错误的环境和配置，无法与用户直接运行 Codex 的行为
保持一致。daemon 只负责 discovery 与 App-origin 启动。

### 终端断开后立即停止或自动 provider resume

拒绝。断开不是权威完成证据；立即停止会丢失仍在运行的 turn。另起 app-server
resume 会制造重复 runtime。允许的 resume 仅限原 Gateway 内新 TUI 的订阅恢复。

## 后果

- CLI 需要管理持久 worker、跨平台本地 transport、受保护控制面和进程恢复。
- App 必须把 terminal、provider connection 和 execution 分开显示。
- Wire 需要可选 generation、Gateway runtime 状态和结构化 cancelled 结果。
- 原生 TUI 功能自动随官方 Codex 升级，但 Happy 必须在云端同时验证最新 stable
  与最低 `0.145.0` schema。
- 异常断开后的 provider 继续消耗本机资源，直到用户 attach 后正常退出、App stop，
  或显式 `happy codex stop`；选择器与状态必须让这一点可见。

## 验证

验收由真实 PTY、官方源码 app-server 和 Responses fixture 驱动，覆盖双端消息、
resume/new/fork、审批 first-win、异常 detach/attach、daemon/app-server 重启、thread
冲突、离线 journal、draining 和 10k snapshot。空转计时不作为证据。
