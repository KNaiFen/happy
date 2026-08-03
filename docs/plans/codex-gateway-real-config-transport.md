# Codex Gateway 真实配置传输修复计划

状态：本地实现与源码验证完成，等待云端验收

## 现场结论

- macOS 安装版 Happy CLI `1.4.33` 已成功启动 Gateway worker 与官方
  `codex app-server 0.146.0`，并创建 Sync v4 会话；provider 和 worker 在前台退出后仍存活。
- 官方 TUI 收到 Happy 主动发送的 WebSocket `1011` 关闭帧，reason 为
  `Gateway transport closed`。`codex_apps`、`openaiDeveloperDocs` 的 MCP 启动中断是断线结果，
  不是 provider 退出原因。
- 带 payload-free 分阶段诊断的真实配置复现捕获到
  `proxy:providerSocket:unsupportedMessageLength`。Happy 将 app-server WebSocket 单消息限制为
  4 MiB，而官方 Codex remote app-server client 的限制是 128 MiB；真实 `codex_apps` / App
  元数据启动流中存在超过 4 MiB 的 provider 帧。
- 将 Happy 的 WebSocket 单消息限制对齐到官方 128 MiB 后，真实用户配置跨过完整 MCP/App
  初始化并稳定保持连接，Gateway 为 `running`、`currentBound=true`、`lastError=null`。
- 先前只观察到约 10.5 KiB / 3.24 MiB 的局部 `app/list` 通知，不能代表完整启动期间的最大帧；
  “已排除 4 MiB 上限”的中间结论已废止。
- 新 thread 在第一条用户消息前没有官方 rollout 文件。现有云端 PTY 场景会立即发送消息，
  因而没有覆盖“空会话保持连接”和空会话异常断开后的 attach 边界。

## 边界

- 保持官方 Codex TUI 交互、稳定 v2 的 Happy canonical 投影、Sync v4 和现有 Gateway
  生命周期不变。
- 不记录或输出 prompt、reasoning、工具参数/输出、provider ID、token 或密钥。
- 只提高本机 app-server WebSocket 帧限制；Sync v4 单 mutation、part、journal 和有界启动缓存
  的既有体积限制保持不变。
- 本地只运行源码测试、类型检查和诊断；官方 Codex 源码构建、CLI 打包及发布验收在
  GitHub Actions 完成。

## 实施步骤

1. 将 Happy 本机 app-server WebSocket 单消息限制从 4 MiB 对齐到官方 Codex 的 128 MiB，
   不放宽 Sync v4 和持久化层的业务载荷限制。
2. 保留 payload-free 诊断：仅持久化代理阶段、是否会关闭传输和固定错误类别；成功绑定新
   terminal 后清除旧诊断，heartbeat 不得提前抹掉仍有效的关闭原因。
3. 增加真实 WebSocket 回归，令 provider 经 Unix socket 向 loopback TUI 返回超过 4 MiB
   的单帧并断言逐字节转发，直接锁死本次边界。
4. 扩展官方 Codex 云端 PTY 门禁：先在无初始 prompt 的新会话窗口内断言 Gateway、provider
   和 terminal 保持健康，再输入首条消息；保留 reasoning summary、工具调用、App 双向
   消息、异常 detach、attach 和正常停止的真实官方 app-server 验证。
5. 在云端真实配置中加入一个成功的 stdio MCP 和一个留下启动标记后退出的非必需 MCP；
   断言失败 MCP 确实启动且不拖断 Gateway，并让后续 App turn 实际调用成功 MCP。大帧边界
   由真实 Unix socket/loopback WebSocket 测试精确覆盖，避免伪造超大工具描述扭曲模型请求。
6. 推进 CLI patch 版本，运行允许的本地源码验证，提交并推送 `origin/main`；等待 CLI、
   主 CI 和相关真实场景全绿，下载并校验新 CLI tgz。

## 验收标准

- 用户真实 Codex 配置下 `happy codex` 不再在启动阶段收到 Happy 生成的 1011 关闭。
- 超过 4 MiB 且不超过官方 128 MiB 上限的 app-server 单帧可双向通过 Gateway；超过官方
  上限的帧仍被拒绝。
- MCP 单项失败只由官方 TUI 展示为对应 MCP 警告，不影响 remote app-server 连接。
- 无首条消息的 TUI 至少在测试观察窗口内保持连接；发送首条消息后产生 rollout，随后
  detach/attach 恢复同一 Gateway、provider、thread 和 Happy session。
- 所有中继错误均可由 payload-free 类别定位，业务载荷和密钥不进入日志或 CI artifact。

## 本地验证进度

- 真实用户配置源码探针：官方 Codex `0.146.0` 完成 MCP/App 初始化并稳定运行 8 秒，
  Gateway 为 `running`、`currentBound=true`、`lastError=null`；探针随后按计划终止前台 TUI。
- CLI TypeScript 与云端 TUI fixture TypeScript：通过。
- Gateway 聚焦回归：`36/36`；Responses/MCP fixture：`8/8`。
- CLI 全量源码单测：`110/110` 文件、`992/992` 测试通过。
- 未在本地构建 CLI、官方 Codex、Web、Android、Rust/Tauri、Docker 或发布产物。
