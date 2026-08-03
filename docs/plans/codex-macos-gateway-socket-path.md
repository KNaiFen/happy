# macOS Codex Gateway Socket Path 修复计划

状态：执行中

## 问题与证据

- Happy CLI `1.4.32` 在 macOS 默认 `TMPDIR` 下生成的 provider Unix socket 路径为
  104 UTF-8 字节。
- 官方 Codex `0.146.0` 执行 `app-server --listen unix://...` 时立即退出并报告
  `path must be shorter than SUN_LEN`；相同命令使用 `/tmp` 下的短路径可以正常监听。
- Gateway 将这一启动失败归类为 `startup:provider:unknown`，因此 `happy codex` 与
  `happy codex resume` 只显示 `Codex Gateway stopped during startup (unknown)`。

## 已锁定方向

1. POSIX Gateway 路径使用 103 UTF-8 字节作为保守上限；长度判断必须使用字节数，
   不能使用 JavaScript 字符数。
2. 正常情况下继续使用系统 `TMPDIR`。完整 provider socket 路径超过上限时，自动回退到
   `/tmp/happy-codex-<profileHash>`；Windows 继续使用已有的认证 loopback TCP，不参与该回退。
3. `/tmp` 回退目录继续保持确定性，以便 worker 重启与 descriptor 恢复能定位同一 endpoint；
   创建后必须验证目录不是符号链接、归当前用户所有，并保持 `0700`。
4. provider 在 spawn 前再次校验真实 socket 路径。显式传入过长 runtime root 时抛出
   `CodexGatewaySocketPathTooLongError`，worker 持久化 `startup:provider:socketPathTooLong`。
5. 不改变 stable-v2、Gateway 生命周期、Sync v4、App、中继或 Windows transport。

## 实施与验证

- 为正常 `TMPDIR`、macOS 长 `TMPDIR`、多字节路径、103/104 字节边界和 provider 预检补回归测试。
- 运行 Gateway state/provider/worker 相关源码测试、CLI 全量源码单测与 TypeScript `--noEmit`。
- CLI patch 版本由 `1.4.32` 推进到 `1.4.33`。
- 完成差异审查和安全检查后归档本计划，提交并推送 `origin/main`。
- 等待 GitHub Actions 的 CLI 发布与主线验收；成功后下载并校验
  `happy-1.4.33.tgz`，不在本地构建发布包。

## 当前结果

- 默认长 `TMPDIR`、显式长路径、UTF-8 多字节边界、provider spawn 前预检、worker
  持久化诊断和 `/tmp` 符号链接防护均已有源码回归。
- 本地 CLI TypeScript `--noEmit`、`110` 个单测文件与 `989/989` 项测试、
  `git diff --check` 全部通过。
- 差异审查未发现 Sync v4、stable-v2、App、中继、Windows loopback 或会话生命周期变更。
- 云端 CLI 发布、主线验收和发布包下载校验仍待完成。
