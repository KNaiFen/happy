# Tauri Desktop 云端打包计划

> **历史归档（2026-08-06）：** 本计划已取消并永久关闭。项目不建立 Tauri
> Desktop 正式发行、签名、公证或持续交付轨道；既有 GitHub Releases 仅作为历史下载入口。

## 状态

- 当前状态：已取消并归档；不再等待平台范围、签名或公证材料。
- 保留范围：Rust/Tauri 源码、现有 entitlements 与 CI 源码门禁继续维护，但不产出正式发行制品。
- 本计划不授权本地 Tauri/Rust 构建；默认验证继续使用 GitHub Actions。

## 已有基础

- `packages/happy-app/src-tauri/tauri.conf.json` 已配置 macOS 最低版本 `10.15`、
  hardened runtime、entitlements 和 Developer ID signing identity。
- `packages/happy-app/src-tauri/entitlements.plist` 已存在。
- `.github/workflows/ci.yml` 已执行 Rust 格式、检查和测试。
- 生产、预览和开发配置继续共享同一 Tauri 源码边界。

## 已取消范围

- [x] 不启动 macOS、Windows 或 Linux 正式发行范围，不宣称已有签名支持。
      不默认宣称已有签名支持。
- [x] 不建立 Tauri 发行版本权威源或版本触发工作流。
- [x] 不导入 Developer ID 证书，不执行 notarization 或 stapling。
      日志不得输出证书、密码或公证凭据。
- [x] 不构建、校验或上传 `.app`、`.dmg`、Windows 或 Linux 安装包。

## 验收标准

- 构建只在 GitHub Actions 完成，不依赖开发机缓存或本地钥匙串。
- 产物可追溯到唯一 package version 与 source commit。
- macOS 产物通过 `codesign`、`spctl`、notarization/stapling 和冷启动检查。
- 失败时不上传或标记可发布产物，敏感材料不进入日志和制品。
- 本计划已取消；当前发行范围见 [发行矩阵](../../release-matrix.md)。
