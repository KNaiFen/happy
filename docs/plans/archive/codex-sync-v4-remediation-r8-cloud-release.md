# Codex Sync v4 R8 云端发布归档

## 状态

- 完成日期：2026-07-30
- 功能提交：`64170a01 修复中继设备接入与离线重连`
- 发布门禁修复：`2d4591f 修复中继发布脚本检查`
- 发布版本：CLI `1.4.6`、Server `1.1.24`
- 保持版本：App `1.11.11`、Wire `0.1.3`

## CI 结果

- 分支 required CI `30480248306`：成功。
- 首次 main CI `30481191249`：成功。
- 最终 main CI `30507381851`：成功。
- 两次 main CI 的真实 stable-v2 turn 均持续超过十分钟并正常完成。
- stable-v2 drift、Codex provider-to-App、HTTP relay/WebSocket/polling、
  migration、Server Bun build、App Web、Tauri 和 dependency Critical gate
  全部通过。

## CLI 制品

- 工作流：`30481191285`，成功。
- Artifact：`happy-cli-1.4.6`。
- 本地文件：`dist/release-artifacts/happy-1.4.6.tgz`。
- 大小：100.6 MB。
- SHA-256：
  `82fc6856febce07fd1b3bfa546d44095c1025fbdba4fee930f5b288a9e2f2f71`。
- 包内名称和版本为 `happy@1.4.6`。
- macOS ARM64 `difftastic` 与 `ripgrep` archive 均存在。

## Relay 发布纠正

- 1.1.23 release `30481191295` 在 ShellCheck SC2016 阶段停止，未构建制品；
  详细原因已归档到
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.23-ci.md`。
- 修复推进到 1.1.24，未复用已运行的版本。
- 1.1.24 release 结果另见
  `docs/plans/archive/debian13-amd64-relay-bundle-1.1.24-release.md`。

## 本地制品整理

1.4.6 和 1.1.24 校验完成后，删除本地已过时的 1.4.5 与 1.1.22 制品；
历史制品仍可从对应 GitHub Actions 重新下载。
