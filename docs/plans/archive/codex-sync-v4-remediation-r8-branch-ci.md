# Codex Sync v4 R8 分支 CI 与 main 同步归档

## 状态

- 完成日期：2026-07-30
- 提交：`64170a01 修复中继设备接入与离线重连`
- 分支：`codex/sync-v4`
- 分支 CI：GitHub Actions `30480248306`，全部通过
- main 同步：fetch、rebase 后以普通 push 完成，未 force

## 完成门禁

- PostgreSQL migration 空库部署、旧库升级、drift、索引和级联检查。
- Wire、Agent、CLI、Server、App 类型检查、测试和构建。
- Server Bun runtime build 与 production dependency Critical audit。
- App Web export、HTTP 平台策略和 macOS Tauri fmt/check/test。
- Codex `0.145.0` stable-v2 生成协议 drift 检查。
- Codex provider-to-App 真实 HTTP relay、WebSocket、polling、持久化和投影场景。
- 真实 stable-v2 turn 持续超过十分钟，未出现时间驱动的假结束。
- required gate 汇总成功。

后续 main CI、CLI/relay release、制品下载和物理设备验收继续记录在活动计划，
不在本归档内累积。
