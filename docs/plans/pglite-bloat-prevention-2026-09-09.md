# PGlite 数据库异常膨胀预防 PLAN

## 状态

状态：进行中；用户已批准“开始执行PLAN”，覆盖实现、验证、PR 交付和 Relay 补丁部署。

- 日期：2026-09-09；负责人：当前任务主代理。
- 基线：`ab5d31e915f93d44baa8763ecb21177cebe67f79`；Relay `1.1.48`。
- 当前请求：执行已批准的数据库膨胀预防 PLAN。
- 本轮终点：必要验证、审查、合并、Relay 补丁及生产观察全部通过，完成归档和精确清理。
- 下一步：按本 PLAN 完成实现、必要验证、审查及 Relay 补丁交付。
- 沿用项目共享计划目录，只保留这一份活动 PLAN；不重新进行 CI 优化分析。

## 目标与边界

保留用户数据、现有账户删除语义和 Sync v4 正确性，阻止高频访问产生的旧行版本长期累积，并在维护失效或容量异常时给出可核验的告警。

成功不定义为数据库永不增长。新增会话、消息、附件和必须保留的同步记录会合理占用空间；本任务控制无效行、索引和 WAL 的异常积累，不用删除有效数据换取固定容量。

- 生产仍使用一个 Relay 进程持有一个 PGlite 数据库实例。
- 自动维护不启动第二个数据库进程，不安排周期停机，不运行 `VACUUM FULL`。
- 不删除会话、消息、附件、数据库文件或 WAL；不修改现有保留、ACK、游标和快照规则。
- 不迁移到外部 PostgreSQL，不升级 PGlite/Prisma，不新建任务平台或监控服务。
- 维护允许有经验证的短暂排队，不能声称 PGlite 单连接维护完全无阻塞。

## 现状证据

2026-09-09 已完成的生产清理记录如下，属于本任务基线，不在生产重复制造膨胀或重复压缩：

| 对象 | 维护前 | 维护后 |
| --- | --- | --- |
| Account | 1 条有效记录、行内容 1,644 字节；关系占用 20,226,801,664 字节 | 81,920 字节 |
| Session | 19 条有效记录、行内容 223,035 字节；关系占用 1,255,399,424 字节 | 344,064 字节 |
| 所有数据库关系 | 已确认 Account/Session 严重膨胀 | 291,209,743 字节 |
| 数据卷，含保留或可复用 WAL | 清理前磁盘无可用空间 | 1,371,373,568 字节；宿主机可用 33,217,568,768 字节 |

维护前后行数及内容摘要一致。旧开发镜像和 syslog 的一次性清理已完成，属于另一类空间占用，不将其混入数据库修复效果。

当前代码与依赖：

- `packages/happy-server/sources/app/account/accountWriteGate.ts:12` 的 `acquireAccountWrite` 为准入而更新 `Account.updatedAt`；`:35` 的 `acquireAccountRead` 复用同一更新。
- `sources/storage/seq.ts` 的用户、会话序号分配仍有必要更新。只修复读准入不能替代例行空间回收。
- `sources/storage/db.ts:39` 创建唯一运行中 PGlite 实例；`getPGlite()` 已提供复用入口。
- `sources/index.ts:24` 和 `sources/main.ts:16` 是服务启动入口；现有 shutdown handlers 并发执行，新增维护停止动作必须在数据库断开之前被明确等待。
- `sources/app/monitoring/metrics2.ts:190` 目前只采集估计行数，不能反映关系和 WAL 占用；Debian Relay 的 `METRICS_ENABLED=false`，不能只增加无人读取的 Prometheus 指标。
- 当前依赖为 PGlite `0.3.15`、adapter `0.6.1`、Prisma `6.19.2`。本轮在全新内存库做了低成本兼容性探针，未连接生产数据库：
  - 引擎报告 PostgreSQL `17.5`；同版本 Prisma Serializable 事务可执行参数化 `FOR NO KEY UPDATE`，准入前后的 `xmin`、`ctid` 不变。
  - `VACUUM (ANALYZE, TRUNCATE FALSE, PARALLEL 0)` 可执行。
  - 设置 `statement_timeout=1ms` 后，`pg_sleep(50ms)` 仍成功耗时约 51ms；12 次更新后立即读取 `n_tup_upd/n_dead_tup` 仍为 0，手动 VACUUM 后 `last_vacuum` 才可见。

结论：准入更新与缺少例行维护是已定位的增长机制；各调用路径的历史贡献比例未测量。不得以 `autovacuum=on`、零 dead-tuple 估计或 JavaScript 超时返回作为已维护、已中断的证明。

## 实现方案

### 1. 消除准入产生的无效 Account 更新

在现有调用者的事务中，将 `acquireAccountWrite` 内部操作替换为 Prisma 参数化原始查询：

```sql
SELECT 1 AS admitted
FROM "Account"
WHERE "id" = $1 AND "deletionRequestedAt" IS NULL
FOR NO KEY UPDATE
```

- Prisma 使用 `$queryRaw` 模板绑定账户 ID，返回一行表示准入；不拼接账户 ID。
- `acquireAccountRead` 继续复用同一锁协议；`requireAccountWrite` 的错误及返回契约不变。
- 保留 Serializable 事务、现有 P2034 重试和多账户排序去重。锁在事务结束时释放，与删除标记更新和账户删除互斥。
- 实测 `$queryRaw` 序列化冲突的 Prisma 映射；如返回 `P2010` 且 `meta.code=40001`，在 `inTx.ts` 中将这个精确组合纳入同一有限重试。其他原始 SQL 错误继续抛出，不增加宽泛重试或默认准入。
- 选择 `FOR NO KEY UPDATE` 以匹配当前非键字段更新的锁强度；不切换到进程锁、无锁查询或 `FOR KEY SHARE`。
- 准入不再修改 `updatedAt`；真实设置、资料、序号更新继续按原实现修改字段。检查账户时间戳消费者，不能偷偷把准入当成用户活跃时间。
- 仅调整需要 `$queryRaw` 的事务类型和直接受影响的测试替身；不批量重写路由。

### 2. 在唯一 PGlite 实例中定期回收空间

新增 `sources/storage/pgliteMaintenance.ts`，由两个服务入口在存储和 API 初始化后启动，仅 `getPGlite()` 非空时启用。迁移命令和外部 PostgreSQL 不启动此循环。

- 使用单个自调度 timer：启动后 60 秒开始，每次完成后至少等 60 秒；同一时刻最多一个维护任务，不累积 tick。
- 从数据库目录发现 `public` 下普通持久表，按稳定顺序轮转，包含迁移表；表名来自数据库目录，按标识符规则引用。TOAST 与索引随所属表处理，不重复调度。
- Account、Session 成为到期优先项，正常负载下每 10 分钟各维护一次；其余表轮转，当前约 29 张表应在一小时内覆盖。调度不能让其余表长期饥饿。
- 每个 tick 仅维护一张符合预算的表，独立执行 `VACUUM (ANALYZE, TRUNCATE FALSE, PARALLEL 0)`，完成后释放给普通请求。
- 直接通过唯一实例的 `pg.exec()` 正常队列执行单条 SQL，不放进 Prisma/PGlite 事务，也不借低层协议绕过队列。不得把 SET/VACUUM/RESET 打包成隐式事务。
- 使用固定周期保证即使统计为零仍维护；dead tuples、统计时间只作诊断，不作为唯一触发条件。
- 以关系总大小包含 heap、TOAST、索引作为输入工作量上限，初始自动维护上限 256 MiB/表。超过上限报告 `oversize`，继续处理其他表；不能静默跳过或自动执行 FULL。
- 记录 `pg.exec()` 调用至完成的总耗时，包含排队，不伪称已独立测得引擎执行时间。单表 2 秒为验收及慢维护告警阈值，不冒充硬取消期限；某表超限或连续失败后将重试频率降至每小时一次，继续维护其他表。保持告警直到恢复成功，避免无声永久停用。
- `statement_timeout` 和 `Promise.race` 均不作为保护手段；SQL 未完成时绝不启动下一项或宣称数据库可关闭。
- 每小时至多执行一次独立 CHECKPOINT，占用一个独立 tick，记录耗时及前后 WAL 大小；同样应用 2 秒慢维护告警。WAL 可复用文件不要求归零，不手动删除。
- 初始上限是待测实现参数。云端样本若不能满足耗时要求，应降低工作量上限或改进实现并重测；不得放宽验收数字来消除失败。当前生产表若超出已验证范围，则记录未覆盖项，不能声称完成预防。

停止时先取消 timer 并等待已开始的维护，再断开 Prisma 和关闭该 PGlite 实例；在现有数据库 shutdown callback 内保证这个先后顺序，不依赖多个 callback 注册顺序。避免独立关闭动作与业务事务互相竞争。

### 3. 容量观测与失效告警

复用现有日志和指标库，不开放新公网接口。在数据目录维护一个原子替换的最新状态文件 `pglite-maintenance.json`，只存维护状态和有限聚合值，不写进数据库、不保留无限历史。

- 状态：schema version、采样时间、启用状态、最近完整轮转和 CHECKPOINT 时间；每张已发现表的大小、估计活跃/废弃行数、最近成功时间、耗时、连续失败数、退避或超限原因；数据库关系总量、WAL 大小、数据所在文件系统可用字节和比例。
- 统计读取也走同一实例；磁盘容量使用 `statfs(PGLITE_DIR)`。不递归扫描整个数据卷，不读取业务 payload，不保存账户、会话、provider ID、令牌或原始错误文本。
- 基础采样并入同一个 tick，每分钟至多一次；写文件使用同目录临时文件及原子 rename，只覆盖最新快照。快照仅供观测，不成为第二套任务数据库；重启重新建立轮转，不把旧成功时间当作本进程已完成维护。
- 文件写入和 SQL 失败在后台任务边界明确记录，失败不更新成功时间；下一次正常调度按既定退避继续，不能出现未处理 rejection 或把失败标为成功。
- 新增 `relayctl.sh storage-health`，通过容器内 Node 读取这一份状态，输出简短容量和维护摘要。健康退出 0、warning 退出 1、critical 或缺失/损坏/版本不支持/超过 3 分钟未更新退出 2；维护停用至少为 warning。不能另开 PGlite 查询生产库。
- 文件系统可用不足 20% 或 5 GiB 时 warning；不足 10% 或 2 GiB 时 critical。仅告警，不自动删数据或阻断业务写入。
- 连续三次 SQL 失败、热表 30 分钟无维护成功、普通表两小时无成功、超出单表预算、单次维护超时，均报告 warning。失败和超限当次保留真实结果。
- 一小时采样比较总关系和 WAL：增长超过 `max(256 MiB, 上次大小的 25%)` 给出“增长需检查”，不直接判定为 bloat。首次启动或缺少可比样本显示未知，不能当作增长为零。
- 日志只在状态变化及每小时摘要时输出；实际使用 `warn`/`error` 级别函数，不能把 `level` 字段塞进固定 info 函数当作告警。Prometheus 启用时可复用同一采样状态，不新增第二轮数据库扫描。
- 文档给出 `storage-health` 检查方式和告警处理：区分新数据增长、空间复用、WAL、统计失真和维护失败；不提供自动清空数据库的快捷命令。

### 4. 配置、版本与兼容性

- 只增加 `PGLITE_MAINTENANCE_ENABLED` 一个公开开关，默认开启，`false` 仅用于故障处置；停用在状态和检查命令中可见。
- 维护周期、单表预算等先使用模块内常量，避免增加未经验证的自由调参面板。
- 数据库 schema、PGlite 文件格式、HTTP/Socket.IO/Wire 协议均不改变。
- 实现影响 Server/Relay 运行行为，将 `happy-server-self-host` 从 `1.1.48` 递增到未使用的下一补丁，预期 `1.1.49`；若该版本已跑发行工作流则继续递增。
- 当前 CLI 通过独立 Server 包或 Relay 使用服务器，不包含本次改动的协议消费者变更；不为该计划提升 CLI、App、Wire、happy-agent 版本。若实施发现实际打包依赖事实不同，按受影响制品规则补齐并记录依据。

## 文件范围

| 文件或模块 | 修改目的 |
| --- | --- |
| `packages/happy-server/sources/app/account/accountWriteGate.ts` | 准入改用行锁，更新事务类型和注释 |
| `packages/happy-server/sources/storage/pgliteMaintenance.ts`，新增 | 唯一实例维护循环、采样与最新状态 |
| `packages/happy-server/sources/storage/db.ts`、`sources/storage/inTx.ts`、`sources/index.ts`、`sources/main.ts` | 实例复用、精确事务重试、启动和有序关闭 |
| `packages/happy-server/sources/app/monitoring/metrics2.ts` | 必要的既有指标接入，共用采样 |
| `packages/happy-server/sources/app/account/`、直接受影响的路由测试 | 真实锁/删除并发与现有替身兼容 |
| `packages/happy-server/sources/storage/pgliteMaintenance.spec.ts`，新增 | 同版本真实 PGlite 的维护、持久化与调度集成验收 |
| `packages/happy-server/deploy/debian13-amd64/relayctl.sh`、`compose.yaml`、`env.example` | 状态检查命令与应急开关传入 |
| `scripts/ci/test-standalone-server-container.sh`、`test-debian13-relay-bundle.sh` | 成品运行、状态读取和重启后的维护验收 |
| `.github/workflows/ci.yml` | 在既有 PostgreSQL 及 Server job 加入必要验收，不重新设计 CI |
| `packages/happy-server/package.json`、部署 README、`docs/deployment.md`、`docs/backend-architecture.md` | Server 补丁版本、维护行为及运维说明 |

`sources/storage/seq.ts` 和 Prisma schema 为重点回归对象，不预设需要重构。只有现有 workflow 分类未覆盖新增检查时才最小补齐分类及对应测试。

## 验证与通过条件

本机复用 MacBook Air M4 / 16 GB / 256 GB 环境事实；空闲容量不改变项目既定云端构建安排。只运行源码检查及小型临时数据库测试，保留依赖与缓存。Docker、完整发行包、官方 Codex 编译和持续负载验收在标准 GitHub Actions runner 完成。

### 本地源码验证

```bash
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy-server-self-host exec vitest run sources/app/account sources/storage/pgliteMaintenance.spec.ts
pnpm --filter happy-server-self-host test
pnpm docs:sync
pnpm docs:check
```

如当前 shell 仍无 `pnpm`，复用已安装入口或直接运行 package.json 声明的同一 Node/Vitest/tsc 命令；不为文档校验安装工具。新增专项测试集中在真实行为，timer/文件故障只保留必要确定性覆盖，不增加镜像源码字符串的碎片单测。

### 必要云端验收

1. **账户删除顺序**：在现有 PostgreSQL service 的两个真实 Prisma client 上，验证读/写准入先成功时删除等其事务完成；删除先提交时后续准入拒绝，事务旧快照按现有重试处理。同步验证多账户顺序、外部操作准入和 artifact 并发，保留现有断言。PGlite 用唯一实例并发提交两个事务，验证排队而非双进程访问。
2. **准入无新行版本**：固定账户执行至少 10,000 次纯准入事务，确认 `updatedAt`、`xmin`、`ctid`、业务内容均不变。行锁可能写页/WAL，不以“零磁盘写入”为成功条件。
3. **空间复用**：使用同版本文件型 PGlite、真实 Prisma schema 和唯一 owner，构造固定存量的 Account/Session/SessionEntityV4，至少 5 个等量更新轮次、总计至少 100,000 次更新；独立事务并覆盖宽行/TOAST。对照维护关闭与开启，记录每轮 heap/TOAST/index/WAL 字节，不只看估计 dead tuples。热身后后两轮维护组关系大小不超过第三轮的 120% 加 1 MiB，且不随累计更新持续线性增长；关闭组必须展示可测的增长差异，否则样本不能证明修复效果。
4. **维护可用性**：在最多 2 CPU / 2 GiB 的云端容器约束下，覆盖小表及 256 MiB 边界、过大表、慢表退避、维护 SQL 失败、状态过期和重启恢复。2 秒阈值是实际总耗时验收，不通过则修复；每轮健康查询无 5xx/超时，代表性读写请求 p99 不超过无维护对照的两倍加 100ms。测试总耗时可设 workflow 上限，该上限不能伪称 SQL 已取消。
5. **生命周期**：运行中事务阻挡维护时数据保持正确；维护中发起关闭时只停止后续调度，等待既有操作完成。重启读取同一卷后内容摘要一致，周期恢复，旧快照不会冒充新的成功；不出现每次重启重新压缩或清理数据。
6. **真实成品**：既有 Server/Standalone Docker/Relay 成品检查读取最新维护状态，确认普通 PostgreSQL 不启用 PGlite 循环。保留迁移、重启、依赖、容器和发布门禁。账户锁变化影响共享 Relay，保留当前分类器触发的官方 Codex lifecycle/恢复和 App Field 验收，固定被测 SHA，不用假 app-server 代替。

持续负载用新增显式 `test:pglite-maintenance:stress` 入口及 CI job 步骤运行；默认本地 `test` 只覆盖小型实例。失败必须留存有限 JSON 汇总及必要日志，不上传生产数据库。

## 执行、交付与完成

已批准执行，按以下顺序连续推进，已有项目交付规则直接沿用：

1. 主代理实施并负责最终验证和方案取舍，遵循本项目“代码修改由主代理负责”的规则；需要独立技术核验时只派只读范围明确的审查。计划阶段不创建执行分支/worktree 或启动执行角色。
2. 使用 `origin` 的短期任务分支和一个主实现 PR，遵守现有严格 required checks，不削弱规则或 force push。本地计划提交可一起进入该 PR，不为计划单独推送。代码、测试、补丁版本、维护文档和交付前已知的记录整理放在同一任务 PR。
3. 源码及专项云端验收通过后进行消融审查：保留一个维护循环、一个状态快照和现有观测入口，移除无实际用途的抽象、配置、重复采样与测试。
4. 合并后等待精确 main 的必要 CI、官方场景和 Relay 发行 promotion；下载并验证同一 SHA 的 Debian 13 amd64 Relay-only bundle 及校验和。
5. 按项目 Production Relay Deployment 规则部署到已约定的腾讯云 Relay 主机：保留 secret、原命名数据卷和其他容器，不创建自动数据备份，不扩大清理范围。版本替换本身允许正常部署重启；例行维护不重启服务。
6. 生产只做容量/状态/健康观察，不造压测数据。部署后至少观察 65 分钟，确认热表多次维护、当前全部表一轮成功、至少一次 CHECKPOINT、状态持续新鲜，关系及 WAL 大小可解释；既有健康/版本/source/secret/卷/其他容器检查全部通过。任何表因大小被跳过或耗时退避都必须明确处置，不能标成已全覆盖。
7. 观察属于短期投产验收，不能声称证明未来永不膨胀。交付记录给出起止容量、实际维护耗时、成功次数和未覆盖风险，后续检查可直接使用 `storage-health`。
8. PLAN 在实施验收结束、进入交付时移入 `docs/plans/archive/`，明确交付待定事实；合并/部署后才产生的结果写本机 `.agents/`，避免仅为补记结果再开 PR。全部必要投产验收通过才报告整个任务完成。
9. 仅在新版本验收成功后清理本任务临时目录、已合并任务分支/worktree、精确旧 Relay 镜像和制品；保留依赖、缓存和用户工作现场。

故障处置：维护异常可通过已记录的开关停用以恢复服务，但保持告警并明确任务未达成；数据格式无变化，可恢复已验证旧 Relay 镜像。SQL 报错不能改用第二进程维护、自动 FULL、删除 WAL 或更改数据保留规则。需要这些材料性改法时先修订本 PLAN。

## 技术依据

- [PostgreSQL 17 VACUUM](https://www.postgresql.org/docs/17/sql-vacuum.html)：普通 VACUUM 回收空间供关系内部复用，FULL 需要重写和额外锁；维护必须在事务外执行。
- [PostgreSQL 17 行锁](https://www.postgresql.org/docs/17/explicit-locking.html)：`FOR NO KEY UPDATE` 的锁冲突和事务边界；行锁仍可能产生磁盘写入。
- [PGlite 文档](https://pglite.dev/docs/)与 [API](https://pglite.dev/docs/api)：单连接实例与 query/exec/transaction 使用边界。当前实现以本仓库锁定版本及真实探针为准，不直接套用最新版新增能力。
