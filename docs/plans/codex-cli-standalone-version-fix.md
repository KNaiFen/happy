# Happy CLI 独立版本命令修复计划

## 现场故障

CLI `1.4.7` 执行 `happy --version` 时先输出版本，随后继续进入认证和 Machine
初始化。若当前 relay 与凭据绑定来源不同，命令会以错误退出；查询本地版本因此
错误依赖凭据、网络、relay 配置和 daemon 状态。

## 修复边界

- [x] npm `bin/happy.mjs` 在导入主 bundle 前处理独立的 `happy --version`
      和 `happy -v`，只输出 Happy CLI 版本并以 0 退出，不初始化配置目录、
      不读取凭据、不启动 daemon、不访问网络。
- [x] 保留组合参数以及 `happy claude --version` 的既有 Claude 参数透传语义，
      避免扩大行为变更。
- [x] 使用绑定到不同 relay 的隔离凭据启动已构建 CLI，证明独立版本命令不再
      进入 `scopeCredentialsToCurrentRelay`。
- [x] 运行 CLI 定向测试、全量 unit/typecheck/build 和差异检查。
- [ ] 推进 CLI patch 版本，中文提交并推送 `origin`，跟踪 required CI 与 CLI
      release 至全绿，并下载校验新的 tgz。

## 不变约束

- 不改变 Codex stable-v2、Sync v4、HTTP 信任边界或 App/Server 版本。
- 不安装本地发布工具链；正式 npm 包继续只由 GitHub Actions 构建。
- `.agents` 状态只在本地更新，不进入 Git。
