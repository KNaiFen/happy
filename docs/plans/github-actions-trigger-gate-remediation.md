# GitHub Actions 提交与 PR 触发去重及发布门禁整改计划

## 状态

- 当前状态：进行中（阶段 1 仓库内实现已完成，等待 PR 云端验收）。
- 建立日期：2026-08-10。
- 当前基线：`origin/main@4e2f7d981b8881bcec597b6b4ec3bc69c2e58ab4`。
- 实施分支：`codex/kb-maintenance-20260810-actions`。
- 负责范围：`.github/workflows/`、知识库活动计划与 GitHub 仓库治理设置。
- 版本边界：本计划只改变文档和 CI/发行编排，不改变可分发行为，不提升任何包版本。
- 外部依赖：`main` ruleset、GitHub Actions 安全设置和真实 Android 设备验收必须在 GitHub 或外部设备上完成，不能以本地文件修改代替。

## 背景与事实证据

2026-08-10 对 `KNaiFen/happy` 的 Actions 审计采集了每个活动工作流最近最多 20 次运行，共 148 次 run、145 次终态 run。样本中有 9 组同一工作流、同一代码树的 `push -> pull_request -> main push` 三元组；若保留 PR 验收、移除两次重复 push，理论上可减少 16,682 runner 秒（约 278 分钟）。

[PR #27](https://github.com/KNaiFen/happy/pull/27) 的 31 个变更文件全部为 Markdown/MDX，但包内 README 仍命中 `packages/**`：

- 分支 push CI [31330932331](https://github.com/KNaiFen/happy/actions/runs/31330932331) 与 PR CI [31330966290](https://github.com/KNaiFen/happy/actions/runs/31330966290) 分别执行一次完整 17-job CI；
- PR CLI Smoke [31330966223](https://github.com/KNaiFen/happy/actions/runs/31330966223) 的四个矩阵腿重复 checkout、安装依赖、构建和打包；
- 合并后的 main CI [31331654785](https://github.com/KNaiFen/happy/actions/runs/31331654785) 再次执行完整 CI；
- main Field [31331654740](https://github.com/KNaiFen/happy/actions/runs/31331654740) 因包内文档被触发，已消耗约 1,285 runner 秒后被定时 run 取消。

GitHub API 同时确认：`main` 当前没有 branch protection，仓库 ruleset 为空；`Required CI gate` 只是工作流内的聚合 job，不是 GitHub 强制合并门禁。CLI release [31321425775](https://github.com/KNaiFen/happy/actions/runs/31321425775) 也曾在同 SHA 的 Monorepo CI [31321425900](https://github.com/KNaiFen/happy/actions/runs/31321425900) 完成前上传制品。

## 目标

1. 同一 PR 的功能代码默认只执行一次权威 PR 验收；分支 push 不再与 PR 重复跑完整 CI。
2. Markdown/MDX 只进入知识库检查，不触发 Monorepo CI、CLI 打包 Smoke 或 Android Field。
3. CLI Smoke 对同一提交只构建和打包一次，Linux/Windows、Node 20/24 仅安装并运行同一组归档。
4. `main` 的合并、直接写入和发行必须受可证明的 Required CI 与打包 Smoke 门禁约束。
5. 发行制品只从通过全局 CI 的同一 SHA 提升；外部 Codex 与 Android APK 按不可变输入复用。
6. 工作流权限、第三方 Action、依赖审查、超时、并发和诊断产物具备明确的安全与可观测边界。

## 明确非目标

- 不删除 11 分钟真实 PTY、官方 app-server、数据库迁移、Android 签名、Relay Trivy/SBOM 等有事实价值的验收。
- 不把失败测试改成无条件重试或软失败，不通过降低门禁强度换取绿色状态。
- 不在本地构建 CLI、Android、Relay、Tauri、Web 或官方 Codex 发行制品。
- 不在没有管理员确认时自动修改 GitHub ruleset、Actions allowlist、Dependabot、CodeQL 或 environment protection。
- 不把 x86_64 模拟器 Field 结果表述为 ARM64 生产 APK 或实体 Snapdragon 设备验收。

## 实施阶段

### 阶段 1：触发范围与 CLI Smoke 构建复用

- [x] `ci.yml` 和 `docs-knowledge-base.yml` 的 `push` 只监听 `main`，PR 只监听目标为 `main` 的变更。
- [x] Monorepo CI、CLI Smoke 和 Android Field 从代码路径中排除 Markdown/MDX。
- [x] CLI Smoke 的路径补入 root `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`scripts/ci/**`、`scripts/postinstall.cjs`、`patches/**` 与 `.npmrc`。
- [x] CLI Smoke 显式使用只读权限、PR 级并发取消和合理 job timeout。
- [x] CLI Smoke 增加单一 prepare job；四个运行矩阵腿下载同一组固定文件名 npm 归档，不再重复 pnpm install、build、Prisma/Web bundle 和 pack。
- [x] 所有工作流通过结构化 YAML 解析和 `actionlint v1.7.7` 静态检查。
- [ ] PR Documentation、CLI Smoke 和 Required CI 在同一 head SHA 上成功，且分支 push 不产生重复 run。

阶段 1 的直接收益只计算已实施的保守范围：样本中的 9 个 branch push 合计 8,328 runner 秒（138.8 分钟）。等价 main tree 的 8,354 runner 秒仍保留；两者合计为上述 16,682 秒。直到阶段 3 建立强制 PR 门禁和同 SHA 全局 gate 后，main 重复才能安全消除；本阶段不以缺少 main 验收换取速度。

### 阶段 2：变更影响规划与不可变制品复用

- [ ] 为 Monorepo CI 增加始终运行的变更分类入口，按包依赖关系启用必要 job；Required gate 明确接受有意跳过的 job，但拒绝失败或取消。
- [ ] 保留 Wire 变更对 CLI、Server、App、Agent 等消费者的保守传递，不做仅凭目录名的危险跳过。
- [ ] Official Codex 以解析后的 release tag、peeled commit、Rust toolchain 和 runtime marker 形成不可变指纹；CI 与 Field 复用同一已验证归档。
- [ ] Android Field 将 App 源码指纹与 Codex 指纹分离；相同 App 指纹的定时运行复用已验证 APK，不重复 Gradle 构建。
- [ ] 用新的 run 样本比较 wall time、runner time、cache restore/export 和失败定位时间，不仅比较单次绿色耗时。

### 阶段 3：全局门禁与发行提升

- [ ] 设计一个不会被 path filter 留在 pending 的始终运行 PR gate，并将 `Required CI gate`、CLI Smoke 与 Documentation 映射为稳定 required checks。
- [ ] GitHub `main` ruleset 要求 PR、分支最新、禁止直接 push，并限制管理员 bypass；启用前先验证 docs-only 与 root-only PR 都能产生终态检查。
- [ ] CLI、Android、Relay、happy-agent 的 release workflow 只在同一 SHA 的全局 gate 成功后进入 build/promotion。
- [ ] 将“构建候选物”与“提升可交付物”分离；promotion 只消费既有 digest，不重新构建。
- [ ] Android 上传独立 checksum/attestation；所有正式制品记录 source SHA、版本、摘要、保留期和下载入口。
- [ ] 为 release workflow 自身和打包脚本增加不发布的 `workflow_dispatch` 或 PR rehearsal 路径。

### 阶段 4：Field 稳定性、队列与失败前移

- [ ] 用 Happy SHA + Official Codex commit 指纹消除 `main push` 与 daily schedule 的同输入互相取消、重跑。
- [ ] 修复 Field recovery 场景的真实失败；在稳定前不把它设置为必需合并门禁，也不使用盲目 retry。
- [ ] Relay 将能在源码/契约层发现的问题前移到 Docker 构建之前；必须依赖最终 bundle 的安装、迁移、重启和安全检查仍保留在交付验收。
- [ ] 对长期 queued、superseded 和超过 SLA 的 workflow 建立终止与告警规则，不把无 job 的 queued run 当作发行证据。
- [ ] 对 Relay `cache-to: mode=max` 做受控 A/B；只有持续减少总 runner/wall time 时才保留最大导出。

### 阶段 5：供应链与外部验收

- [ ] 将第三方 Action 固定到完整 commit SHA，并通过 Dependabot 或 Renovate 维护更新；先覆盖 release、artifact 和密钥相关路径。
- [ ] 启用 Dependabot security updates、PR dependency review 与适用的 CodeQL/SAST；保留现有 secret scanning、push protection、Critical dependency audit 和 Relay Trivy/SBOM。
- [ ] 在真实 ARM64 目标设备上安装生产签名 APK，验证升级安装、真实网络切换、relay reconnect 与关键 Codex 生命周期；保留精确 workflow、artifact 和设备证据。
- [ ] 根据实际交付方式决定是否需要 GitHub Environment 审批、发布后健康检查和回滚；构建-only 工作流不得冒充生产部署。

## 验收矩阵

### 本地源码级验证

```bash
node --check scripts/docs/knowledge-base.mjs
node scripts/docs/knowledge-base.mjs --check
git diff --check
git diff --cached --check
```

还必须用结构化 YAML 解析器读取所有 `.github/workflows/*.yml`；本机不运行打包、Android、Docker、Tauri 或官方 Codex 构建。

### PR 云端验证

- 分支 push 不产生 Monorepo CI、Documentation 或 CLI Smoke run；打开/更新 PR 后只产生一组对应检查。
- 第一阶段 PR 的 Documentation、CLI Smoke 与 Required CI 对同一 head SHA 成功。
- CLI Smoke prepare 只运行一次；Linux/Windows 四个矩阵腿都下载同名 artifact，并分别通过 Node 20/24 安装与命令检查。
- docs-only 对照 PR 只运行 Documentation；root lockfile 或 workspace 配置变更必须运行 CLI Smoke 和 Monorepo CI。

### main 与外部验证

- merge SHA 的 post-merge/main 工作流按设计运行；任何 release 候选物只能引用该精确 SHA。
- ruleset、Actions 安全设置和真实设备验收记录管理员、时间、URL 与结果，不以计划勾选代替外部证据。
- 完成后重新采样至少 20 次相关 workflow，报告重复 run、runner 分钟、wall P50/P90、取消率和失败阶段分布。

## 风险与回滚

- GitHub path filter 和 required check 组合可能造成检查永久 pending；在 ruleset 生效前必须用 root-only、docs-only 和代码 PR 验证。
- Linux 生成的 CLI/Wire 归档应为平台无关；Windows 四矩阵腿会提供实际安装证据。若归档不可移植，回滚 prepare 复用，不得跳过 Windows 检查。
- Artifact 下载可能抵消小型 job 的准备收益；只在云端 runner 数据证明有效时继续推广到 Monorepo CI。
- TUI 真实时序和 Field recovery 不能用缩短 sleep 或扩大 timeout 掩盖；优化应来自触发范围、确定性测试和制品复用。
- 任一工作流修复若导致门禁缺席、错误跳过或制品来源不明，应回滚该阶段的独立提交，不继续推进后续阶段。

## 下一步

1. 精确暂存计划与 workflow 源文件，生成并暂存知识库索引。
2. 创建 PR，确认 branch push 不再双跑，等待同一 PR head 的 Documentation、CLI Smoke 和 Required CI。
3. 第一阶段合并并取得 main 证据后，更新本计划的实际节省与 run URL，再开始阶段 2。

## 完成条件

- [ ] 五个阶段均有实现提交、精确 GitHub run 或外部设置证据。
- [ ] 同一 PR 不再出现分支 push、PR 和等价 main tree 的三次全量 CI。
- [ ] docs-only 变更不运行代码、打包或 Android Field；root 打包输入不会漏掉 CLI Smoke。
- [ ] 所有正式 release 制品都在同一 SHA 的全局 gate 后由既有 digest 提升。
- [ ] Field 的取消率和真实失败已分别治理，实体 ARM64 验收仍有可追溯证据。
- [ ] 活动计划更新为已完成并移入 `docs/plans/archive/`，生成索引与本机记忆同步收尾。
