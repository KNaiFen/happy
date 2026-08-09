# Happy Server standalone Docker 路径修复计划

## 状态

- 当前状态：进行中（需先确定修复还是移除该路径）。
- 负责模块：`packages/happy-server` 与 Relay 部署维护者。
- 建立日期：2026-08-10。
- 云端边界：任何新的 container 或可交付物验收都必须在 GitHub Actions 中运行，不在本机构建发行镜像。

## 已确认事实

`Dockerfile.server` 仍使用不存在的 `pnpm --filter happy-server`，而现行包名是
`happy-server-self-host`。它的 `CMD` 也启动标准 `start` entrypoint，该 entrypoint 默认使用 Postgres，而不是
PGlite standalone entrypoint。因此，原 README 所声称的“单 container、不需 Postgres/Redis/S3”无法由这个镜像实现。
受支持的发行路径是 Debian 13 amd64 Relay bundle。源码中的
`sources/standalone.ts` 仍可供开发/诊断使用，但它不是已验收的 root Docker 制品。

## 决策与下一步

1. 确认是否继续保留 root Docker 路径：不继续则移除 `Dockerfile.server`
   及所有对它的部署承诺；继续则修复为真正的可重现运行时镜像。
2. 若修复，使 Dockerfile 使用正确的 workspace 包名和 standalone
   `migrate`/`serve` entrypoint，为 PGlite 和本地附件存储提供持久路径。
3. 将受支持的镜像或移除行为纳入云端工作流，否则不得在 README 中声称它可部署。
4. 等决策走通后，用实际对应的实现、工作流和制品证据更新
   `packages/happy-server/README.md`、`docs/deployment.md` 和归档记录。

## 验收标准

- 不论保留还是移除，`Dockerfile.server` 与 README 不再给出互相矛盾的自托管承诺。
- 若保留，云端验收能从空数据目录启动、运行 migration、重启后保留 PGlite/附件数据，并验证不需额外的
  Postgres、Redis 或 S3。
- 若移除，仓库不再提供该 Docker build 命令，仅保留已验收的 Debian Relay 包和源码诊断入口。
- 任一结论都附有精确 commit 和 GitHub Actions run 证据，不用本机镜像构建替代云端验收。
