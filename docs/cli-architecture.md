# Happy CLI 架构

> **当前文档（2026-08-05）：** 未指定 provider 的新会话只启动 Codex。
> 历史非 Codex 路径的启动、认证、连接、恢复、fork、UI、SDK 和 prompt fallback 已移除。

## 入口与运行形态

`happy` 和 `happy codex` 都进入 Codex 路径。CLI 负责：

- 设备认证与 Happy Server 连接；
- 启动或附着官方 Codex app-server；
- 本地 Native TUI 与远端 App 同时控制同一 thread；
- Codex stable-v2 通知到 Sync v4 实体的投影；
- mutation、command、cursor 和恢复状态的持久化；
- machine daemon 与保留 RPC 基础设施。

主要源码位于 `packages/happy-cli/src/codex`，持久 Gateway 位于
`packages/happy-cli/src/codex/gateway`。

## Codex app-server 边界

Happy 以 `codex-cli 0.145.0` 为最低支持版本，生成协议类型时固定使用
`codex app-server generate-ts` 且不开 experimental API。运行时拒绝更旧或无法识别的
Codex 版本；已识别的控制命令使用官方 RPC，失败时显式报错，不退化为 prompt 文本。

`codexAppServerClient.ts` 与 WebSocket transport 管理初始化和 RPC；
`codexThreadRegistry.ts` 按真实 thread/turn/item ID 路由通知。未知 thread 先建立
placeholder 并执行权威读取，绝不猜测为当前 thread 或 parent。

只同步官方 reasoning summary。raw reasoning 只允许本地计数，不写入 journal、日志或网络。

## 持久 Gateway

Gateway 将 Codex app-server 生命周期从一次前台 shell 中分离：

- launcher/worker 创建并守护 app-server；
- descriptor、secret、lease 和 append-only journal 位于
  `~/.happy/codex-gateways/` 的私有目录；
- control server 与 WebSocket proxy 让 Native TUI、headless CLI 和恢复流程附着同一 Gateway；
- thread lease 阻止两个存活 Gateway 同时拥有同一 Codex thread；
- stale descriptor、worker crash 和 handoff 通过进程身份、generation 和 journal 恢复；
- Gateway state 不允许泄露 bearer token、加密 key 或 provider payload。

Native TUI 的终端字节流和 App 的结构化 Sync v4 投影是两条不同视图，生命周期所有权仍在
同一个 Gateway/app-server。架构决定见
[ADR-004](decisions/ADR-004-codex-native-tui-gateway.md)。

## Sync v4 客户端

`codexSyncV4Mapper.ts` 把 provider 通知映射为 thread、runtime、turn、item、part、
request、command/result 和 parent/child relation。`codexV4CommandProcessor.ts` 与
`codexV4CommandExecutor.ts` 执行来自 App 的不可变 command。

客户端先把 outbound mutation 写入 `~/.happy/sync-v4/` JSONL journal，再按 FIFO 上传。
inbound change 先落 journal、再解密执行，处理成功后才推进 receive cursor。最终截断记录可恢复，
compaction 使用原子替换。

Socket.IO 只是唤醒提示；CLI 通过 changes polling 和 snapshot replay 保证恢复。RPC timeout、
transport loss 或 interrupt ACK 只表示结果未知，不能结束 turn。

## 命令与控制

- prompt/steer 通过稳定 RPC，并使用 command ID 关联 `clientUserMessageId`；
- `/compact` 映射 `thread/compact/start`，以对应 compaction item 生命周期为完成证据；
- `/review` 映射 `review/start`；
- approval、user input 和 interrupt 都绑定预期 request/turn ID；
- 非幂等控制在 RPC 结果未知时不会盲目重放；
- provider child thread 是隔离的只读 side session，不能接受 App 写命令。

Codex stable-v2 没有稳定写入 permission profile 与 collaboration mode 的请求字段；
Happy 只展示官方观测值，不使用 experimental API 或 prompt 伪造。

## 共享基础设施

CLI 仍使用 API auth、machine/session clients、Socket.IO RPC 与 `@slopus/happy-wire`。
Gemini、OpenClaw、Agy、generic ACP 和共享 v3 基础设施只有在保留消费者仍使用时才存在；
这些保留模块不会让未知会话获得 Codex 写权限。

## 验证与发行

源码验证覆盖 app-server client、thread registry、Gateway launcher/proxy/journal/lease、
Sync v4 mapper、command routing、migration、child identity 和集成 fixtures。官方 Codex
源码编译与真实 app-server 接受测试只在 GitHub Actions 运行。

CLI 可交付包由 `.github/workflows/build-cli-release.yml` 在版本变更时构建。产物必须是单个
`happy-X.Y.Z.tgz`，包含 macOS ARM64 `rg` 与 `difftastic` 归档，并经过安装冒烟测试。
