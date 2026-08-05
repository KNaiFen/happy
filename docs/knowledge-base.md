# 项目知识库

本仓库的文档按“当前事实优先、历史可追溯、机器可校验”维护。入口是
[文档首页](README.md)，完整清单由 [文档总目录](CATALOG.md) 自动生成。

## 权威顺序

当文档互相矛盾时，按以下顺序处理：

1. 当前实现、测试和已发布工作流；
2. 已接受且未被标注替代的 [ADR](decisions/README.md)；
3. 当前工程文档；
4. 活动计划；
5. 审查、研究和归档材料。

历史文档用于解释当时的判断，不会覆盖当前代码或 ADR。发现矛盾时，应修正当前文档，或将旧文档移入归档并加上替代说明，不删除仍有审计价值的记录。

## 目录与生命周期

| 位置 | 用途 | 生命周期 |
| --- | --- | --- |
| `docs/decisions/` | 长期架构决定（ADR） | 只追加或显式标记替代关系 |
| `docs/` | 当前架构、协议、部署和产品说明 | 与实现同行更新 |
| `docs/plans/` | 有负责人和下一步的未完成工作 | 完成、取消或替代后移入 `archive/` |
| `docs/plans/archive/` | 已完成或已替代的计划 | 保留验收证据，不作路线图 |
| `docs/reviews/` | 仍有行动项的审查 | 结案后移入 `docs/reviews/archive/` |
| `docs/research/`、`docs/competition/` | 带日期的研究快照 | 不作为产品或协议权威来源 |
| `docs/archive/` | 其他历史材料 | 不作为当前规范 |

本机运行记忆位于未跟踪的 `.agents/` 与 `AGENTS.md`：它们链接本知识库，但不进入 Git，也不替代可共享的工程文档。

## 维护动作

- 修改协议、部署、发行或包版本时：同步修改相应当前文档，并运行 `pnpm docs:sync`。
- 新增 Markdown/MDX 时：先将新文件加入 Git 暂存区，再运行 `pnpm docs:sync`，使生成结果
  只依赖可提交的 Git 索引，不受本机未跟踪草稿影响。
- 新建计划时：在 `docs/plans/` 写明 `## 状态`、目标、证据和下一步；不再活跃时立刻归档。
- 完成审查后：将结论写入 ADR、当前文档或测试，再归档审查原件。
- 改动任意 Markdown、发行工作流或包版本后：运行 `pnpm docs:check`。GitHub Actions 也会执行同一检查。

## 自动生成与校验

`scripts/docs/knowledge-base.mjs` 直接读取 Git 索引中的文件路径和 blob 内容（已跟踪或
已暂存），因此生成与校验针对将要提交的快照，不受未暂存编辑或本机草稿影响。它生成：

- [文档总目录](CATALOG.md)；
- [ADR 索引](decisions/README.md)；
- [活动计划](plans/README.md) 与 [计划归档](plans/archive/README.md)；
- [发行矩阵](release-matrix.md)。

它还校验 Markdown 与 HTML 本地链接、标题锚点、活动计划状态和生成文件是否过期。
生成文件只能通过 `pnpm docs:sync` 更新。

## 发布与制品

发行版本、GitHub Actions 工作流与交付文件见 [发行矩阵](release-matrix.md)。普通本地验证只运行源码级检查；CLI、Android、Debian Relay、happy-agent、Web 和 Tauri 的可交付制品由云端工作流构建和验证。
