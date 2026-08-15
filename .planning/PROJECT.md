# Happy

## What This Is

Happy 是一个面向开发者的远程编码代理控制系统，monorepo 同时包含 Wire、Server、CLI、App、Gateway 与云端验证工作流。当前受维护的默认会话路径是基于官方 Codex app-server、stable-v2 和实体化 Sync v4 的 Codex-only 架构。

## Core Value

开发者能够跨终端与 App 可靠、安全地控制 Codex 会话，并在断线、重启和恢复场景中保持权威且可重建的状态。

## Requirements

### Validated

- ✓ Codex 已成为唯一活跃默认 provider，未知和遗留 metadata 不会被推断为可写 Codex 会话 — ADR-003
- ✓ Codex canonical state 使用实体化 Sync v4、持久队列、独立 ACK/cursor、journal replay 与 snapshot — ADR-001
- ✓ 会话归档、provider timeline 与 connection/execution 状态使用相互独立的权威证据 — ADR-002
- ✓ 官方 Codex TUI 通过持久 Gateway worker 运行，支持 detach、attach、lease 与 generation 隔离 — ADR-004
- ✓ daemon 提供同源、只读、保守分类的恢复资格预检 — ADR-005
- ✓ GitHub Actions、CodeQL、Dependabot 与生产依赖审计具有明确供应链门禁 — ADR-006

### Active

- [ ] 关键 ADR 约束持续由代码、测试或 CI 证据覆盖
- [ ] 完整 monorepo 的 Codex 协议、同步、Gateway、恢复和供应链边界可独立验证
- [ ] 暂态故障、transport loss 与 timeout 永不被误判为 provider 完成或恢复结果
- [ ] 运维与验证日志持续保持 payload-free，不泄露 prompt、reasoning、tool payload、provider ID、token 或密钥
- [ ] ADR 与当前实现发生漂移时能够在进入发布或生产变更前被检测

### Out of Scope

- 恢复遗留 provider 的 launch、authentication、resume、fork、UI、SDK 或 prompt fallback — ADR-003 明确要求重新引入 provider 必须另立 ADR
- 使用 experimental Codex API 弥补 stable-v2 能力缺口 — 当前支持边界固定为非实验 stable-v2
- 同步或记录 raw reasoning text — 只允许官方 reasoning summaries
- 从 transport loss、RPC timeout、interrupt ACK 或经过时间推断完成 — 只有权威生命周期或 reconciled snapshot 可结束执行
- 在没有新 ADR 的情况下声明自动生产部署、GitHub Environment、审批或回滚门禁 — ADR-006 明确排除

## Context

这是一个已有实现和历史验证证据的 brownfield monorepo，不是从零开始的产品。`.planning/codebase/` 已包含完整代码库映射；本规划由 `docs/decisions/` 下 6 份 Accepted ADR 和生成式 ADR 索引综合而来。当前规划目标不是重复实现已经部署的架构，而是建立可追踪、可分阶段补强的持续验证基线。

## Constraints

- **Provider**: 未指定的新会话只能默认 Codex；可写会话必须显式携带 `flavor=codex` 与 `codexSyncVersion=4` — 防止遗留 metadata 进入未验证路径
- **Codex compatibility**: 只使用非实验 stable-v2，最低支持 `codex-cli 0.145.0` — 保持官方 RPC 与生成 schema 的稳定边界
- **Sync correctness**: 正确性来自持久队列、独立 ACK/cursor、轮询、journal replay 与 snapshot；Socket.IO 仅作唤醒提示 — 避免连接事件成为数据权威
- **Lifecycle**: 只有 provider 权威生命周期或 reconciled snapshot 能结束执行 — timeout、断线和 ACK 不具备完成语义
- **Child isolation**: Codex child threads 是独立只读 side sessions，不能覆盖 parent runtime state — 保持父子状态隔离
- **Security**: 运行日志必须 payload-free，禁止记录 prompt、reasoning、tool 参数/输出、provider ID、token、加密密钥或签名材料 — 缩小敏感数据暴露面
- **Local verification**: 日常本地验证仅使用 source-level checks；release、Android、Relay、Tauri、Docker 和官方 Codex 构建留在 GitHub Actions — 遵守项目构建边界

## Key Decisions

<decisions>
  <decision status="locked" source="docs/decisions/ADR-001-codex-sync-v4.md">Codex canonical state 使用实体化 Sync v4、durable clients、stable-v2 和隔离的只读 child sessions。</decision>
  <decision status="locked" source="docs/decisions/ADR-002-codex-session-lifecycle-and-timeline-order.md">归档、timeline order、connection state 与 execution state 使用相互独立的权威证据。</decision>
  <decision status="locked" source="docs/decisions/ADR-003-codex-only-provider.md">Codex 是唯一活跃默认 provider；遗留 provider 路径保持 unsupported。</decision>
  <decision status="locked" source="docs/decisions/ADR-004-codex-native-tui-gateway.md">官方 Codex TUI 通过持久 Gateway worker 运行，不由 Happy fork、patch 或重实现。</decision>
  <decision status="locked" source="docs/decisions/ADR-005-daemon-resume-eligibility-preflight.md">恢复资格由 daemon 执行同源只读预检，最终 Resume 仍需重新执行权威检查。</decision>
  <decision status="locked" source="docs/decisions/ADR-006-actions-security-and-production-dependency-gates.md">Actions 保持 SHA pin；CodeQL 与 High/Critical 生产依赖审计形成合并门禁。</decision>
</decisions>

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Entity-based Sync v4 | 断线与重启后仍可通过 journal、polling 和 snapshot 恢复 canonical state | ✓ Good |
| Codex-only default | 消除 provider routing ambiguity 与遗留 fallback | ✓ Good |
| Persistent official-TUI Gateway | 解耦终端、provider 与 Sync bridge 生命周期 | ✓ Good |
| Read-only resume preflight | 首页资格展示不应修改会话生命周期 | ✓ Good |
| Pinned Actions and production audit gates | 供应链风险必须在合并前被可重复检测 | — Pending continuous verification |

---
*Last updated: 2026-08-15 after ADR document ingestion*
