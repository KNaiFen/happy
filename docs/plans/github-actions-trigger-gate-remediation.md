# GitHub Actions 提交与 PR 触发去重及发布门禁整改计划

## 状态

- 当前状态：进行中（阶段 1、阶段 2 的变更分类与 Official Codex 跨 run 制品复用、阶段 3 的稳定 PR gate/ruleset，以及阶段 4 的 Field recovery 修复均已完成并有云端证据；阶段 3 的 release same-SHA gate 已合并且失败闭合路径已有云端证据，但成功 gate 路径曾被一次 `pnpm install` 进程泄漏阻塞。当前分支已实现候选清单、Actions/API/下载三重 digest 绑定、不重建 promotion、有界流式下载、逐跳 HTTPS 重定向校验、ZIP EOCD 预检与原子提取，并固定发行链及其 Required CI/Official Codex 信任链的 Action SHA；阶段 2 的 APK 复用与性能采样、阶段 3 的真实制品验收，以及阶段 4 至阶段 5 的其余工作仍未完成）。
- 建立日期：2026-08-10。
- 当前基线：`origin/main@5f4754642a3a55f2d3bfca5bcb09e9ac7d161e66`。
- 当前实施分支：`codex/kb-maintenance-20260810-release-promotion`，只改变 CI/发行编排、测试和本文档，
  不改变包版本或可分发行为。
- 本地复审：候选下载与提升逻辑、候选 ZIP 预检与原子提取、发行 workflow 和本文档已完成独立复审；
  最终复审没有 Critical 或 Important 发现。真实候选 rehearsal 和外部环境验收仍按下文保持未完成。
- 实施记录：PR [#28](https://github.com/KNaiFen/happy/pull/28)，PR head
  `580a64baef6383b3fb7aa012d9672f4edd1a8591`，squash merge
  `1bfc78994dede1a1ee4e65a9384db0d0350136f9`。
- 稳定 gate 实施：PR [#30](https://github.com/KNaiFen/happy/pull/30)，PR head
  `c359156f0bc390167570c93e0f17c83cc3a389d3`，squash merge
  `d68a74a63977a5e19bf803875e02663994963a34`。
- docs-only 证据与规则集：PR [#31](https://github.com/KNaiFen/happy/pull/31)，PR head
  `c17e8a38596bf1c354b6bc8c2d6955a2faa524a7`，squash merge
  `fe493da0d7b143557717853f0ae3eb3e7f4ce488`；GitHub ruleset
  [`main PR and stable CI gates`](https://github.com/KNaiFen/happy/rules/20624143) 已 active。
- Field launcher 首次修复：PR [#32](https://github.com/KNaiFen/happy/pull/32)，PR head
  `b657356157f1abb6f24c322d619068ca93925fb2`，squash merge
  `53a31f3afab862cb6858cbc7cf41c7d7be29f7bf`；merge-SHA Field
  [31362434710](https://github.com/KNaiFen/happy/actions/runs/31362434710) 未通过，失败证据见阶段 4，
  不能以 PR CI 成功替代 API 36 恢复验收。
- Field launcher 显式组件修复：PR [#33](https://github.com/KNaiFen/happy/pull/33)，PR head
  `25114c2ba9e41f978ec40ceaccf4c0d89e3ca8e5`，squash merge
  `0b972972503d1bcc736a2f1ed796d6cbce8ce3f3`；merge-SHA Field
  [31368887798](https://github.com/KNaiFen/happy/actions/runs/31368887798) 未通过，失败证据见阶段 4，
  不能以 PR CI 成功替代 API 36 恢复验收。
- Field launcher 唯一组件行筛选：PR [#34](https://github.com/KNaiFen/happy/pull/34)，PR head
  `03aeaf45662de35831f91048fa964175b1c3b5d3`，squash merge
  `ba4e0e7a8f58524e40fb4ce7272c8b5f35c8a9b9`；PR 的 Documentation
  [31372564420](https://github.com/KNaiFen/happy/actions/runs/31372564420)、CLI Smoke
  [31372564078](https://github.com/KNaiFen/happy/actions/runs/31372564078) 和 Monorepo CI
  [31372564863](https://github.com/KNaiFen/happy/actions/runs/31372564863) 成功；精确 merge-SHA
  Field [31373901326](https://github.com/KNaiFen/happy/actions/runs/31373901326) 成功，诊断
  artifact [9058100566](https://github.com/KNaiFen/happy/actions/runs/31373901326/artifacts/9058100566)
  关闭了阶段 4 的 recovery 阻塞，详细证据见下文。
- Official Codex 跨 run 制品复用：PR [#35](https://github.com/KNaiFen/happy/pull/35)，PR head
  `95ce2f76429bb082ef60f51399f329d3c11eeab6`，squash merge
  `47d95bacec5d59e0efee8ea16ad5366721198bbb`。PR 的 Documentation
  [31378727717](https://github.com/KNaiFen/happy/actions/runs/31378727717)、CLI Smoke
  [31378727716](https://github.com/KNaiFen/happy/actions/runs/31378727716) 和 Monorepo CI
  [31378728078](https://github.com/KNaiFen/happy/actions/runs/31378728078) 均成功；merge-SHA
  Documentation [31379919984](https://github.com/KNaiFen/happy/actions/runs/31379919984)、
  Monorepo CI [31379920438](https://github.com/KNaiFen/happy/actions/runs/31379920438) 与
  `workflow_run` Field [31381065818](https://github.com/KNaiFen/happy/actions/runs/31381065818)
  均成功，详细复用证据见阶段 2。
- Release same-SHA gate：PR [#37](https://github.com/KNaiFen/happy/pull/37)，PR head
  `d5b71b2d3867fffd26ef7f76efb101c631ce511e`，squash merge
  `5f4754642a3a55f2d3bfca5bcb09e9ac7d161e66`。PR 的 Documentation
  [31388597000](https://github.com/KNaiFen/happy/actions/runs/31388597000)、CLI Smoke
  [31388597019](https://github.com/KNaiFen/happy/actions/runs/31388597019) 和 Monorepo CI
  [31388597298](https://github.com/KNaiFen/happy/actions/runs/31388597298) 均成功；merge-SHA
  Documentation [31390088051](https://github.com/KNaiFen/happy/actions/runs/31390088051) 成功，
  但 Monorepo CI [31390088194](https://github.com/KNaiFen/happy/actions/runs/31390088194)
  因一个依赖安装进程未退出而在 25 分钟 job 时限失败。后置发行路由
  [31392233424](https://github.com/KNaiFen/happy/actions/runs/31392233424) 恰好运行一次，
  `source_gate`、版本检测和四个构建均 skipped，artifact 总数为零，证明失败时闭合；成功 gate
  与未变版本分类仍须由新的 merge SHA 证明。
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
- [x] CLI Smoke 增加单一 prepare job；四个运行矩阵腿下载同一组固定文件名 npm 归档，不再重复 pnpm install、build、Prisma/runtime/Web bundle 和 pack。Linux 另以无源码 checkout 的临时项目同地安装三份 tgz，避免 server 源码 fallback 冒充归档验收。
- [x] 所有工作流通过结构化 YAML 解析和 `actionlint v1.7.7` 静态检查。
- [x] PR Documentation、CLI Smoke 和 Required CI 在同一 head SHA 上成功，且分支 push 不产生重复 run。

阶段 1 的直接收益只计算已实施的保守范围：样本中的 9 个 branch push 约占 8,190 runner 秒，等价 main tree 约占 8,354 runner 秒；审计按不同 job 终止时间取样，分项与总量存在约 138 秒的口径差异，因此只将理论节省记为约 16,682 runner 秒（约 278 分钟）。直到阶段 3 建立强制 PR 门禁和同 SHA 全局 gate 后，main 重复才能安全消除；本阶段不以缺少 main 验收换取速度。

阶段 1 的 PR 云端验收均针对同一 head SHA `580a64ba`：

- Documentation [31336163611](https://github.com/KNaiFen/happy/actions/runs/31336163611)、
  CLI Smoke [31336163603](https://github.com/KNaiFen/happy/actions/runs/31336163603) 和
  Monorepo CI [31336163776](https://github.com/KNaiFen/happy/actions/runs/31336163776) 全部成功，
  `Required CI gate` 成功；该 SHA 没有产生 `push` 事件的重复 run。
- CLI Smoke 的 prepare 只运行一次并耗时 187 秒；Linux 20/24 分别耗时 67/61 秒，
  Windows 20/24 分别耗时 174/161 秒。四个运行 job 均复用 prepare 生成的同一组归档。
- 相比整改前的代表 run
  [31330966223](https://github.com/KNaiFen/happy/actions/runs/31330966223)，Smoke 墙钟从
  475 秒降至 368 秒，减少 107 秒（22.5%）；job runner 时间合计从 1,228 秒降至
  650 秒，减少 578 秒（47.1%）。该结果只证明本次布局的实际收益，不外推为长期
  P50/P90；长期结论仍需完成验收矩阵要求的至少 20 次重新采样。

合并提交 `1bfc78994dede1a1ee4e65a9384db0d0350136f9` 的 main 验收结果：

- Documentation [31336894548](https://github.com/KNaiFen/happy/actions/runs/31336894548) 成功。
- Monorepo CI [31336894660](https://github.com/KNaiFen/happy/actions/runs/31336894660) 成功，
  墙钟 1,033 秒、17 个 job 合计 2,100 runner 秒；Required CI gate 成功。TUI job
  耗时 794 秒，其中真实 PTY 场景 708 秒，不能以删除场景作为优化手段。
- Android Field [31336894628](https://github.com/KNaiFen/happy/actions/runs/31336894628) 未通过：
  Official Codex 构建成功（114 秒），APK 构建和前三个 flow 成功（bootstrap 8 秒、App
  surface 3 秒、round trip 1 分 26 秒），但 recovery flow 在 9 分 53 秒后因
  `Waiting for you` 不可见失败。诊断 artifact
  [9045060275](https://github.com/KNaiFen/happy/actions/runs/31336894628/artifacts/9045060275)
  的 `field-diagnostics.json` 为 `rollbackCommandId=null`、
  `rollbackCommandErrorKind=commandMissing`；fixture 日志记录 `fetch failed`，而 Relay
  在失败前的快照请求均为 HTTP 200。该合并提交未修改 Field fixture 或 App 逻辑，故不把它
  归因于阶段 1 的 path filter 修正，也不重试或放宽断言；它是阶段 4 的开放阻塞。现有 fixture
  日志没有时间戳，尚不能证明 `fetch failed` 是首因还是失败清理的副作用；当前可确认的故障边界
  只是 App 未恢复请求 UI，且快照中不存在 rollback command。

同一 merge SHA 的 Field 与 Monorepo CI 仍分别执行了 114 秒和 109 秒的 Official Codex
准备，合计 223 runner 秒，并因当前跨工作流并发组串行。这是阶段 2 不可变指纹与归档复用的
当前量化基线，不应通过删除下游 app-server/TUI/Field 验收来回避。

PR 首轮云端 rehearsal 还确认旧 smoke 的 checkout 会同时掩盖 `happy-server-self-host` 全局同级安装解析和归档缺少 runtime 两个问题。Actions 阶段只校正 smoke 的真实性；可分发修复、版本提升和安装文档同步由[专门活动计划](./happy-server-global-package-resolution.md)承接。

### 阶段 2：变更影响规划与不可变制品复用

- [x] 为 Monorepo CI 和 CLI Smoke 增加始终运行的变更分类入口，按包依赖关系启用必要 job；聚合 gate 明确接受有意跳过的 job，但拒绝失败或取消。分类器单测覆盖 docs-only、Wire 传播、独立包和 root 输入。
- [x] 保留 Wire 变更对 CLI、Server、App、Agent 等消费者的保守传递，不做仅凭目录名的危险跳过；分类器单测验证该传播集合。
- [x] Official Codex 以解析后的 release tag、peeled commit、Rust toolchain 和 runtime marker 形成不可变指纹；CI 与 Field 复用同一已验证归档。
- [ ] Android Field 将 App 源码指纹与 Codex 指纹分离；相同 App 指纹的定时运行复用已验证 APK，不重复 Gradle 构建。
- [ ] 用新的 run 样本比较 wall time、runner time、cache restore/export 和失败定位时间，不仅比较单次绿色耗时。

阶段 2 已实施的路径只改变 `main` 的 Field 输入：Field 改由 `Happy monorepo CI` 完成事件
触发，先核验该精确 `head_sha` 的 `Required CI gate` 成功、唯一未过期
`official-codex-linux-x64` artifact 的 ID 和 Actions API SHA-256 digest，再下载该精确 ZIP。
随后校验 `source.json` 的 Happy SHA、release tag、peeled Codex commit 与 `codex`、
`codex-code-mode-host`、`bwrap` 三个文件摘要；跨 run 没有可读取的 reusable-workflow output，
因此 Field 还从公开的 Codex release tag 重新 peel 出 commit 并与清单匹配，不能把空的
`needs.official_codex.outputs.commit` 当作校验。定时和手动 Field 继续自行构建 Official Codex，
避免在最近仅有文档变更、没有同 SHA CI artifact 时错误复用旧制品。

PR #35 的首个 PR head 暴露 `upload-artifact` 输出裸 64 位 SHA-256、REST API 输出
`sha256:<digest>` 的格式差异；修复后的 `95ce2f76` 接受且只接受这两种小写 SHA-256 形态，
并继续拒绝其他算法、长度和大小写。该 head 的 app-server 与 TUI 消费者均按 ID/digest 成功下载、
校验清单并运行完整生命周期。合并后，main CI [31379920438](https://github.com/KNaiFen/happy/actions/runs/31379920438)
只构建一次 Official Codex；其成功完成才触发 Field
[31381065818](https://github.com/KNaiFen/happy/actions/runs/31381065818)。Field selector 输出
`source_run_id=31379920438`、`head_sha=47d95bac...`、`artifact_id=9059502920` 与
`artifact_digest=sha256:aa409d86...d4ad33d`，没有运行 reusable `official_codex` build job。
Field artifact [9060612275](https://github.com/KNaiFen/happy/actions/runs/31381065818/artifacts/9060612275)
的 `source.json` 是 schema 4，绑定同一 Happy SHA、`rust-v0.147.0`、peeled commit
`be6e8eac...f61b` 和三个可执行文件摘要；其 API 36 job 成功，四个 Maestro JUnit 零失败，
recovery 启动 2.704 秒且 `Status: ok`，最终诊断为 `phase=verified`、rollback
`succeeded/none`、post-clear 成功与 `v4LifecycleCompleted=true`。

这是一组可复现的跨 run 功能验收而非长期性能结论：该 Field job 用时 1,690 秒，较 PR #34 的
1,934 秒少 244 秒，但 Android 构建和共享缓存仍会造成波动。阶段 2 的性能项保留，必须按验收矩阵
重新采样，不能把这一次绿色结果外推为 P50/P90。

### 阶段 3：全局门禁与发行提升

- [x] 让 Monorepo CI、CLI Smoke 和 Documentation 在所有目标 PR 上产生终态检查；重型 job 通过分类器按需跳过，聚合检查保持稳定名称。PR #31 的 docs-only 对照已验证这一行为。
- [x] GitHub `main` ruleset 要求 PR、分支最新、禁止直接 push，并限制管理员 bypass；ruleset `20624143` 要求 `Required CI gate`、`CLI Smoke gate` 和 `Generated indexes and links`，均绑定 GitHub Actions integration `15368`，且 `bypass_actors=[]` / `current_user_can_bypass=never`。未制造无语义的 root-only PR；根安装输入的分类行为由单元测试和 PR #30 的 workflow/scripts 代码路径覆盖。
- [ ] CLI、Android、Relay、happy-agent 的 release workflow 只在同一 SHA 的全局 gate 成功后进入 build/promotion；代码与失败 gate 的 merge-SHA 路由已证明 fail-closed，仍缺成功 gate 的真实候选证据。
- [ ] 将“构建候选物”与“提升可交付物”分离；本地实现只消费既有 artifact ID/digest、不重新构建并在解压前执行资源与路径门禁，仍待真实候选 rehearsal 验收。
- [ ] Android 上传独立 checksum/attestation；所有正式制品记录 source SHA、版本、摘要、保留期和下载入口。
- [ ] 为 release workflow 自身和打包脚本增加不发布的 `workflow_dispatch` 或 PR rehearsal 路径。

代码 PR [#30](https://github.com/KNaiFen/happy/pull/30) 在同一 head SHA `c359156f` 上完成了
三项稳定 gate 验收：Documentation
[31358745202](https://github.com/KNaiFen/happy/actions/runs/31358745202)、CLI Smoke
[31358745206](https://github.com/KNaiFen/happy/actions/runs/31358745206) 和 Monorepo CI
[31358745351](https://github.com/KNaiFen/happy/actions/runs/31358745351) 均成功；后者的
`Required CI gate` 成功，CLI 的单一 prepare 与四个 Node/平台矩阵腿也全部成功。该 PR
修改了 workflow 与 `scripts/ci`，因此分类器保守选择全量验收；这证明了代码路径，尚不代替
docs-only 对照和 GitHub ruleset 的外部证据。

release same-SHA gate 的当前实现使用唯一的 `workflow_run` 路由，而不是让四个发行工作流各自
轮询或重复查询全局 CI。路由只接受同仓库 `push/main` 的首轮成功
`Happy monorepo CI`，再通过 Actions API 重新核验精确 `head_sha`、workflow 路径、run 状态和
唯一成功的 `Required CI gate`；校验脚本从 `github.workflow_sha` checkout，候选源码则只从已
核验的 source SHA checkout。路由还要求 source SHA 关联唯一已合并、目标为 `main` 的 PR，并以
该 PR 的 `base.sha` 统一检测四个版本变化；这覆盖 squash、merge 和 rebase merge，直接 push 或
来源不明的提交不会进入发行。Android `buildCommitSha`、Relay OCI revision、happy-agent source
check 和所有构建 checkout 都绑定同一已核验 SHA。

为避免 release 版本提交的 main CI 被下一次合并取消或替换 pending run 后永久漏发，main CI 的
并发组按 SHA 隔离；PR 更新仍按 PR ref 取消旧 head 的运行。上游 CI 或发行路由的第二次 attempt
不再生成制品：首轮失败、取消或发行构建失败后必须按版本规则提升受影响包的 patch version，不能
通过 rerun 复用已经进入发行编排的版本。当前分支没有包版本变化，因此 PR 和 merge-SHA 只能验证门禁、版本分类和四个
reusable workflow 的静态/调用契约；在新的真实版本提升或不发布 rehearsal 取得云端构建证据前，
本阶段检查项保持未完成。PR #37 的 merge-SHA CI 失败后，路由只产生六个 skipped job 且没有
artifact，证明失败闭合逻辑生效，但不能替代成功路径验收。

当前 promotion 分支把四个 build workflow 的输出改为 7 天候选 artifact：候选清单固定包含
schema、产品、版本、source SHA，以及每个 payload 的文件名、大小和 SHA-256。Reusable workflow
向 router 暴露精确 artifact ID、Actions digest 和 source-bound 名称；promotion 再从 Actions API
按 ID 读取同一 router run 的 metadata，比较 upload output 与 API digest，下载 ZIP 并复算 ZIP
SHA-256，且 promotion receipt 强制这两个摘要相等；在解压前拒绝额外或危险路径，解压后复算清单
与 payload。只有全部一致时，才把同一
payload 连同 promotion receipt 上传为 30 天正式下载入口；promotion job 不运行 pnpm、Gradle、
Docker、pack 或任何构建命令。当前分支又把 ZIP 中央目录校验与提取交给 Python 标准库：先拒绝
ZIP64、多磁盘、异常条目数和超过 64 KiB 的中央目录，再构造 `ZipFile` 并拒绝
额外/重复/穿越/符号链接/加密/高压缩比条目；预检与解析使用同一文件描述符，随后在临时目录中
按声明大小流式提取，成功后原子改名；
CLI、Android、Relay、Agent 的下载 ZIP 上限分别为 256/192/384/32 MiB，对应单一主 payload
上限为 192/128/320/16 MiB；这些门槛依据现有云端制品峰值（CLI 105,350,356、Android
69,837,686、Relay 190,197,608、Agent 38,640 字节）留有增长余量，并由一份结构化策略同时驱动
Node 下载器和 Python 解压器。
Node 下载器把 Actions metadata 限制在 1 MiB 并只接受流式正文，不使用无界 `json()` 或
`arrayBuffer()` 回退；候选 ZIP 也按产品上限流式读取。Metadata API 禁止自动重定向；ZIP API
入口携带 GitHub token，但后续最多 5 个重定向逐跳要求 HTTPS 且不得含 userinfo，并永久移除
`Authorization`，错误也不回显带签名的 `Location`。历史 CLI artifact
`9040323027` 的 API 大小与实际下载 ZIP 均为 105,350,356 字节，且 ZIP 普通文件属性可被新解析器接受。
发行与提升链的 checkout、pnpm、Node、Android/Gradle、Docker、Trivy 和 upload-artifact 均固定到完整
提交 SHA，checkout 设置 `persist-credentials: false`，正式上传改用 `upload-artifact v7.0.1`。
实现已有 Node 15 项、Python 18 项源码测试，覆盖摘要不一致、超限/非流式 metadata、每一跳不安全或
过多重定向、非成功响应体取消、ZIP64、多磁盘、异常 EOCD/中央目录边界、悬空或竞态目标路径，并证明
FIFO 输入会快速失败、EOCD 失败发生在 `ZipFile` 构造前、路径替换不会改变已打开的归档、候选目录
不会覆盖竞态创建的目标，且损坏的 DEFLATE 数据会归一化为受控错误并清理暂存输出；但在
真实版本提升或不发布 rehearsal 完成前，阶段 3 的
候选提升检查项仍保持未完成。

### 阶段 4：Field 稳定性、队列与失败前移

- [ ] 用 Happy SHA + Official Codex commit 指纹消除 `main push` 与 daily schedule 的同输入互相取消、重跑。
- [x] 修复 Field recovery 场景的真实失败；没有把它设置为必需合并门禁，也没有使用盲目 retry。
- [ ] Relay 将能在源码/契约层发现的问题前移到 Docker 构建之前；必须依赖最终 bundle 的安装、迁移、重启和安全检查仍保留在交付验收。
- [ ] 对长期 queued、superseded 和超过 SLA 的 workflow 建立终止与告警规则，不把无 job 的 queued run 当作发行证据。
- [ ] 对 Relay `cache-to: mode=max` 做受控 A/B；只有持续减少总 runner/wall time 时才保留最大导出。

阶段 4 当前证据：Field recovery 在成功 run
[31321425891](https://github.com/KNaiFen/happy/actions/runs/31321425891) 中曾于 5 分 52 秒完成，
但在 merge SHA run [31336894628](https://github.com/KNaiFen/happy/actions/runs/31336894628)
中失败。失败 artifact 的 Maestro `commands.json` 与 `maestro.log` 进一步确认：recovery 的
`launchApp` 从 `21:55:28Z` 到 `22:04:42Z` 耗时 554,522 毫秒，真正的 launcher intent
直到结束前才送达设备；成功对照只耗时 1,894 毫秒。该延迟超过 MCP elicitation 的 4 分钟
生命周期，因此 `commandMissing` 是请求先行结算后的下游结果，不是 Happy rollback 的首因。
最小修复应以 30 秒硬上限的单次 `adb shell am start -W` 替代 Maestro `launchApp`，保留原
process-death、UI、choice、rollback 与 v4 lifecycle 断言；不得加入盲目重试或延长业务超时。
在修复并取得新的成功诊断前，不得将 Field 设为 Required CI gate。

PR #32 已将 recovery YAML 中的 `launchApp` 移除，改为在同一 `killApp` 后、Maestro
断言前执行一次 `timeout 30s adb shell am start -W`，并把 UTC 起止时间和 ADB 输出保存为
`recovery-am-start.txt`。新的 `node:test` 静态契约拒绝重新引入 Maestro 启动或无界 ADB 命令。
这只改变启动执行者，不改变 process-death、`Waiting for you`、choice、rollback、`/clear` 或
v4 lifecycle 断言。该实现的 merge-SHA Field [31362434710](https://github.com/KNaiFen/happy/actions/runs/31362434710)
在 `06:58:58Z` 的恢复启动即失败：`am start -W ... -p com.slopus.happy.dev` 报
`unable to resolve Intent`，没有 `Status: ok`，所以 recovery Maestro、choice、queue、rollback
和 `/clear` 均未开始；主 field flow 在此前已通过。artifact 的 activity dump 列出已安装组件
`com.slopus.happy.dev/.MainActivity`，故这不是 APK 缺失，也不是旧的恢复 UI 断言失败。
新的最小修复使用 `cmd package resolve-activity --brief` 解析目标包的 MAIN/LAUNCHER 组件，再以
显式 `am start -W -n <component>` 启动，并继续保存 package path、解析结果、UTC 边界和启动输出。
解析或显式启动失败仍立即失败；不重试、不延长业务超时，也不勾选该修复项直到新的 Field 诊断为
`phase=verified`。

PR #33 的 merge-SHA Field [31368887798](https://github.com/KNaiFen/happy/actions/runs/31368887798)
证明 PackageManager 解析已经找到安装的组件，但 API 36 的 `--brief` 输出同时包含一行
`priority=0 preferredOrder=0 ...` 元数据和一行
`com.slopus.happy.dev/.MainActivity`。脚本将两行整体作为组件，并因空白校验而在
`08:34:59Z` 立即退出；`recovery-am-start.txt` 没有 `Status: ok`，所以 recovery Maestro、choice、
queue、rollback 与 `/clear` 都未开始。新的最小修复保留原始输出用于诊断，只选择开头为目标包
且不含空白的行，并要求恰好一条候选；随后仍以相同的显式 `am start -W -n` 和 30 秒边界启动。
该筛选、包路径、解析、启动与完整 Sync v4 断言均须由新的 merge-SHA Field 证明，不能仅凭
PR CI 关闭阻塞。

PR #34 将这一选择写成动态 ADB stub 回归测试，覆盖 API 36 的两行实际输出形状；它只接受包名前缀
且无空白的唯一组件，随后必须得到 `Status: ok`。其精确 merge-SHA Field
[31373901326](https://github.com/KNaiFen/happy/actions/runs/31373901326) 于
`2026-08-10T09:51:16Z` 成功：Official Codex job 用时 85 秒，Android Field job 用时
1,934 秒。诊断 artifact
[9058100566](https://github.com/KNaiFen/happy/actions/runs/31373901326/artifacts/9058100566)
中的 `recovery-am-start.txt` 只选择
`com.slopus.happy.dev/.MainActivity`，从 `09:44:03Z` 到 `09:44:06Z` 完成，含
`Status: ok`、`TotalTime: 3500` 与 `WaitTime: 3524`。bootstrap、zero-machine、主 field 和
recovery 四个 Maestro JUnit 均为零失败，recovery 实际用时 352 秒；其命令记录证明恢复后的
choice、queued follow-up、`/compact`、`/clear` 与 post-clear 响应均执行成功。最终
`field-diagnostics.json` 为 `phase=verified`、
`rollbackCommandResultTerminalStatus=succeeded`、`rollbackCommandErrorKind=none`、
`postClearCommandSucceeded=true`、`v4LifecycleCompleted=true`。阶段 4 的 recovery 阻塞至此关闭。

PR #37 的 merge-SHA CI 暴露了另一类长时失败：job
[93459562730](https://github.com/KNaiFen/happy/actions/runs/31390088194/job/93459562730)
在 `12:53:33Z` 开始 `pnpm install --frozen-lockfile`，包链接和 root/App/CLI/Server lifecycle
均在 `12:53:47Z` 前报告完成，但父进程没有退出，也没有继续输出；job 在 `13:18:17Z` 到达
25 分钟时限后取消，runner 清理了两个 `MainThread` 进程和一个 shell。相同 cache key 的成功对照
[31379920438](https://github.com/KNaiFen/happy/actions/runs/31379920438) 在 15 秒内完成同一安装，
而 PR #37 没有修改 package 或 lockfile，因此当前证据不足以归因到依赖内容，也不允许通过重跑
冒充修复。当前分支只给该安装步骤增加 5 分钟独立硬上限；它不跳过任何 lifecycle 或测试，但可把
同类静默卡死的 runner 浪费从 25 分钟压缩到最多约 5 分 30 秒，并为新的 SHA 提供是否复现的终态证据。
更广泛的 SLA/告警检查项仍保持未完成。

### 阶段 5：供应链与外部验收

- [x] 已将 release、artifact、签名/密钥和容器扫描路径，以及作为 release `source_gate` 上游的 Required CI 与 Official Codex reusable workflow 的第三方 Action 固定到完整 commit SHA；这 18 个 checkout 均设置 `persist-credentials: false`，相关 `upload-artifact` 已升级至 v7.0.1（Node 24 runtime）。
- [ ] 为未进入当前 release 信任链的其余 workflow 补齐 SHA pin，并通过 Dependabot 或 Renovate 维护更新；仓库级安全设置仍需管理员证据。
- [ ] 升级仍使用 Node.js 20 action runtime 的非发行 Action；升级后保留上传、下载、摘要和失败诊断语义，不以强制运行兼容层作为长期完成状态。
- [ ] 启用 Dependabot security updates、PR dependency review 与适用的 CodeQL/SAST；保留现有 secret scanning、push protection、Critical dependency audit 和 Relay Trivy/SBOM。
- [ ] 在真实 ARM64 目标设备上安装生产签名 APK，验证升级安装、真实网络切换、relay reconnect 与关键 Codex 生命周期；保留精确 workflow、artifact 和设备证据。
- [ ] 根据实际交付方式决定是否需要 GitHub Environment 审批、发布后健康检查和回滚；构建-only 工作流不得冒充生产部署。

## 验收矩阵

### 本地源码级验证

```bash
node --check scripts/docs/knowledge-base.mjs
node --test scripts/ci/verify-release-source-gate.test.cjs
node --test scripts/ci/release-candidate-promotion.test.cjs
python3 scripts/ci/release_candidate_archive_test.py
node scripts/docs/knowledge-base.mjs --check
git diff --check
git diff --cached --check
```

还必须用结构化 YAML 解析器读取所有 `.github/workflows/*.yml`；本机不运行打包、Android、Docker、Tauri 或官方 Codex 构建。

### PR 云端验证

- 分支 push 不产生 Monorepo CI、Documentation 或 CLI Smoke run；打开/更新 PR 后只产生一组对应检查。
- 第一阶段 PR 的 Documentation、CLI Smoke 与 Required CI 对同一 head SHA 成功。
- CLI Smoke prepare 只运行一次；Linux/Windows 四个矩阵腿都下载同名 artifact，并分别通过 Node 20/24 安装与命令检查。
- docs-only 对照 PR 必须产生 Documentation、`CLI Smoke gate` 和 `Required CI gate` 三个成功终态，同时 CLI prepare、平台矩阵与 Monorepo 重型 job 全部为 skipped；root lockfile 或 workspace 配置变更必须运行 CLI Smoke 和 Monorepo CI。

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

1. 让当前 promotion PR 的精确 head 通过 Documentation、CLI Smoke 和 Required CI；若
   `codex_transport_scenarios` 再次卡住，5 分钟边界必须给出终态，不能重跑或放宽场景掩盖问题。
2. 合并后核验新的 merge SHA 的成功 `Happy monorepo CI`、唯一后置发行路由、source run/job API
   证据和四个未变版本的 skipped 结果；不得把 skipped build 表述为发行制品验收。
3. 在下一次真实 patch version 提升或不发布 rehearsal 中，证明对应 reusable workflow 只在同 SHA
   gate 后构建，并核验候选 artifact ID/API digest、ZIP digest、promotion receipt 和最终下载 URL；
   promotion 必须复用同一 payload，不能重新构建；同时确认私有仓库 ZIP API 首跳鉴权成功、签名
   下载重定向不携带 `Authorization`，并记录候选与正式 artifact 的摘要一致性。
4. 重新采样至少 20 次 Official Codex CI/Field，报告 runner/wall P50/P90、cache 命中、取消率和失败阶段；在有足够样本前不把单次 244 秒差值宣称为长期节省。
5. 将 Android APK 的 App 指纹与 Codex 指纹分离，并仅在新变更的安全/隔离边界有证据后复用 APK；不得以缓存命中替代发行验收。
6. 不制作无语义 root-only PR；下一次真实 root 安装输入变更必须记录其分类器和两个 gate 的云端结果。
7. 在真实候选演练后复核产品上限；若任何正式制品接近 80% 上限，先更新观测证据和测试，再调整策略，不能静默放宽。

## 完成条件

- [ ] 五个阶段均有实现提交、精确 GitHub run 或外部设置证据。
- [ ] 同一 PR 不再出现分支 push、PR 和等价 main tree 的三次全量 CI。
- [ ] docs-only 变更不运行代码、打包或 Android Field；root 打包输入不会漏掉 CLI Smoke。
- [ ] 所有正式 release 制品都在同一 SHA 的全局 gate 后由既有 digest 提升。
- [ ] Field 的取消率和真实失败已分别治理，实体 ARM64 验收仍有可追溯证据。
- [ ] 活动计划更新为已完成并移入 `docs/plans/archive/`，生成索引与本机记忆同步收尾。
