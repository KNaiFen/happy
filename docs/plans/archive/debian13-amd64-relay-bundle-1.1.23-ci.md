# Debian 13 amd64 Happy Relay 1.1.23 云端门禁归档

## 状态

- 日期：2026-07-30
- 分支 CI：全部通过
- main release：GitHub Actions `30481191295` 失败
- 制品：未构建、未上传
- 当前归档结论：失败并由 [Server `1.1.24` 成功发布记录](debian13-amd64-relay-bundle-1.1.24-release.md) 替代。

## 已通过

- Server 生成、类型检查、116 项测试和 Bun runtime build。
- 分支上的 production deploy tree、PGlite 兼容、真实 HTTP relay、
  provider-to-App 场景及十分钟 stable-v2 turn 门禁。

## 失败原因

release 工作流的 ShellCheck 在
`scripts/ci/test-debian13-relay-bundle.sh` 两段单引号内联 JavaScript 上报告
SC2016。单引号是有意设计，用于阻止 shell 展开 JavaScript 模板表达式；
ShellCheck 将模板表达式误判成待展开的 shell 表达式。

修复仅在两条 `container_node -e` 命令前添加局部 SC2016 说明，不改变脚本行为。
由于 1.1.23 release workflow 已运行，按照版本不可复用规则推进到 1.1.24。
