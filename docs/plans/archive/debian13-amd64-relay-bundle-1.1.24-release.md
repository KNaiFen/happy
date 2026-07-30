# Debian 13 amd64 Happy Relay 1.1.24 发布归档

## 状态

- 完成日期：2026-07-30
- 提交：`2d4591f 修复中继发布脚本检查`
- 工作流：GitHub Actions `30507381903`，成功
- Artifact：`happy-relay-server-1.1.24-debian13-amd64`
- 本地文件：
  `dist/release-artifacts/happy-relay-server-1.1.24-debian13-amd64.tar.gz`
  及 `.sha256`

## 云端门禁

- Server 生成、类型检查、116 项测试和 Bun runtime build。
- ShellCheck、最终 bundle verifier、distroless runtime、production deploy tree
  和 Compose 配置。
- `linux/amd64` Debian 13 distroless 镜像身份、非 root 用户和 relay-only 内容。
- Trivy 对 fixed/unfixed Critical 漏洞阻断。
- CycloneDX SBOM、离线 tarball、内部路径/链接和逐文件 SHA-256。
- 交付包实际安装、真实签名认证、非空 Machine/Session、容器重启、数据持久性
  和 v4 toggle。

## 本地独立校验

- tarball 大小：180.1 MB。
- SHA-256：
  `98628ba3d2240faa51fd2bebe96c51d65f6c855cd44f91689f595a7b0c60f383`。
- 外部 `.sha256` sidecar 校验通过。
- `VERSION`、README、Compose、env 模板、安装/控制脚本、SBOM、镜像内包和
  所有内部校验和通过。

服务器原目录升级和物理设备验收仍保留在活动计划，不在本归档内标记完成。
