# Happy 工程知识库

这里是 Happy 仓库内工程事实的统一入口。先阅读 [知识库维护规则](knowledge-base.md)；
需要查找任意文档时使用自动生成的 [文档总目录](CATALOG.md)。

## 当前权威文档

- [Codex Sync v4 决策](decisions/ADR-001-codex-sync-v4.md)：同步、恢复、加密与稳定版 app-server 边界。
- [会话生命周期与时间线顺序](decisions/ADR-002-codex-session-lifecycle-and-timeline-order.md)：执行完成和投影顺序。
- [Codex-only provider 边界](decisions/ADR-003-codex-only-provider.md)：默认会话和保留集成。
- [Codex Native TUI Gateway](decisions/ADR-004-codex-native-tui-gateway.md)：终端与远端控制边界。
- [恢复资格只读预检](decisions/ADR-005-daemon-resume-eligibility-preflight.md)：首页恢复承诺与 daemon 权威检查边界。
- [后端架构](backend-architecture.md)、[CLI 架构](cli-architecture.md) 与 [HTTP API](api.md)。
- [权限解析](permission-resolution.md)、[聊天 Composer 设置菜单](chat-composer-settings-menu.md)、
  [加密边界](encryption.md) 与 [Codex 验收层](agent-testing.md)。
- [部署](deployment.md)、[开发环境](dev-environments.md) 与 [发行矩阵](release-matrix.md)。

`protocol.md`、`session-protocol.md` 和 `realtime-sync-and-rpc.md` 仍记录共享 v3
基础设施及历史兼容上下文；Codex 的当前规范以 Sync v4 ADR 和实现为准。

## 工作状态

- [活动计划](plans/README.md)：只保留尚未完成且有明确下一步的工作。
- [计划归档](plans/archive/README.md)：已完成、取消或被替代的实施记录。
- [审查记录](reviews/README.md)：审查的行动状态与历史入口。
- [项目路线图](roadmap.md)：只指向已核验的活动计划，不维护脱离实现的愿望清单。

## 研究与历史

- [研究说明](research/README.md) 与 [竞品研究说明](competition/README.md) 是带日期的快照，不是当前产品契约。
- [通用归档](archive/README.md) 保存旧路线图、实验草案和包级历史材料。
- 历史结论若与当前文档冲突，以 [知识库权威顺序](knowledge-base.md#权威顺序) 为准。

## 维护

修改文档、包版本或发行工作流后运行：

```bash
pnpm docs:sync
pnpm docs:check
```

CI 会检查生成索引、内部链接和活动计划状态。不要手工编辑标有“自动生成”的文件。
