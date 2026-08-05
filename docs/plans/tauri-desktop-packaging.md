# Tauri Desktop 云端打包计划

## 状态

- 当前状态：活动计划；Rust 源码门禁、macOS entitlements、hardened runtime 和
  Developer ID 配置已存在，发行打包与 notarization 工作流尚未建立。
- 阻塞项：确认首发平台范围，并在仓库 Secrets 中提供对应签名/公证材料。
- 本计划不授权本地 Tauri/Rust 构建；默认验证继续使用 GitHub Actions。

## 已有基础

- `packages/happy-app/src-tauri/tauri.conf.json` 已配置 macOS 最低版本 `10.15`、
  hardened runtime、entitlements 和 Developer ID signing identity。
- `packages/happy-app/src-tauri/entitlements.plist` 已存在。
- `.github/workflows/ci.yml` 已执行 Rust 格式、检查和测试。
- 生产、预览和开发配置继续共享同一 Tauri 源码边界。

## 待完成

- [ ] 明确 macOS 首发是否为唯一强制范围；Windows/Linux 作为独立后续范围，
      不默认宣称已有签名支持。
- [ ] 统一 App package version 与 Tauri bundle version 的权威来源，避免两个版本漂移。
- [ ] 新增仅在版本变更或显式 dispatch 时运行的云端打包工作流。
- [ ] 在 macOS runner 导入短期证书，完成 Developer ID 签名、notarization 和 stapling；
      日志不得输出证书、密码或公证凭据。
- [ ] 对 `.app`/`.dmg` 校验版本、commit、签名链、Gatekeeper、entitlements 和启动行为。
- [ ] 上传带 SHA-256 的 GitHub Artifact；发布后记录工作流、commit 与下载入口。
- [ ] 将 Windows/Linux 打包分别补充格式、签名、安装和启动验收后再纳入发行矩阵。

## 验收标准

- 构建只在 GitHub Actions 完成，不依赖开发机缓存或本地钥匙串。
- 产物可追溯到唯一 package version 与 source commit。
- macOS 产物通过 `codesign`、`spctl`、notarization/stapling 和冷启动检查。
- 失败时不上传或标记可发布产物，敏感材料不进入日志和制品。
- 工作流、产物名称和交付规则写入 [发行矩阵](../release-matrix.md) 后归档本计划。
