# GitHub Actions 提交与 PR 触发去重及发布门禁整改计划

## 状态

- 当前状态：进行中（阶段 1 至阶段 4 的触发去重、稳定门禁、同 SHA 发行、候选提升、Official Codex/Field
  复用和恢复均已有云端证据。PR #57 merge SHA `ec111f88` 上的 npm 生产依赖门禁、advanced CodeQL、
  `Required CodeQL gate`、vulnerability alerts 与 Dependabot security updates 已生效。2026-08-14 的独立
  生产依赖审计先发现 Tauri runtime High `GHSA-82j2-j2ch-gfr8`，将 `rustls-webpki 0.103.4` 更新到
  `0.103.14`，并为云端 Tauri job 增加固定版本、阻断 High/Critical 与无 CVSS vulnerability 的 Cargo
  audit。门禁随后发现既有锁图中的 `RUSTSEC-2026-0007`（`bytes 1.10.1`）、
  `RUSTSEC-2026-0194`/`RUSTSEC-2026-0195`（`quick-xml 0.38.2`）及
  `RUSTSEC-2026-0001`/`RUSTSEC-2026-0235`（`rkyv 0.7.45`）。修复将 Tauri 升至 `2.10.3`、
  `tauri-plugin-log` 升至 `2.9.0`、Rust MSRV 升至 `1.88`，使锁图使用 `bytes 1.11.1` 和
  `quick-xml 0.41.0` 并移除 `rkyv` 链。PR #58 与 merge SHA `eb6111f0` 上固定 Rust `1.88.0` 的
  Tauri audit/check/test、CodeQL 和 Required CI 均成功；App `1.11.49` 已由同 SHA 发行，Dependabot
  `GHSA-82j2-j2ch-gfr8` 已标记 fixed。长期性能采样、Android 独立 attestation、阶段 4 的其余
  Relay/队列优化和实体设备验收仍未完成）。
- 建立日期：2026-08-10。
- 当前基线：`origin/main@eb6111f0044bf3c1d130897e6f2608cc934472be`（PR #58 squash merge）。
- Field canonical secret 修复：PR [#46](https://github.com/KNaiFen/happy/pull/46)，PR head
  `4b7c5de0a10bc513191133db197e21d4c4c16d1d`，已于 `2026-08-11T08:16:52Z` squash merge 为
  `b81e57609cfa5ace8a6fe3d98824dd5bbe72b264`；它不改变包版本或生产可分发行为。
- 本地复审：PR #41 的 Official Codex 复用 Node 12 项测试、Field 去重 Node 9 项测试、综合 Node
  61 项测试、Node syntax check、12 个 workflow 的 Ruby YAML 解析和 `git diff --check` 均通过；测试包含
  mock `gh api` 的空候选、可信 receipt ZIP 和 API 不可用回退。PR #42 的 PR/main 云端对照已补足同 recipe
  main artifact 命中、main re-attestation、Field receipt 下载校验与同 SHA 后继跳过证据；外部环境验收继续按
  下文保持未完成。
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
- 候选安全提升与成功 gate 证据：PR [#38](https://github.com/KNaiFen/happy/pull/38)，PR head
  `557c3c30bb6136320dfcf413932b432bada8370a`，squash merge
  `3cf1727449592273c0a3ab6cbfb48c7d1f77be20`。PR 的 Documentation
  [31404045087](https://github.com/KNaiFen/happy/actions/runs/31404045087)、CLI Smoke
  [31404045108](https://github.com/KNaiFen/happy/actions/runs/31404045108) 和 Monorepo CI
  [31404047733](https://github.com/KNaiFen/happy/actions/runs/31404047733) 均成功；merge-SHA
  Documentation [31405741335](https://github.com/KNaiFen/happy/actions/runs/31405741335) 和
  Monorepo CI [31405741401](https://github.com/KNaiFen/happy/actions/runs/31405741401) 均成功。
  唯一后置路由 [31407154579](https://github.com/KNaiFen/happy/actions/runs/31407154579) 的 source gate
  与版本检测成功，四个候选构建及四个 promotion 均 skipped，artifact 总数为零；这证明成功 gate
  和未变版本路径不会误发制品，但不替代真实候选 rehearsal。
- 统一 promotion 与不发布 rehearsal：PR [#39](https://github.com/KNaiFen/happy/pull/39)，PR head
  `1d901d0aeb7b18cdd22d998daa6cf8f78171bb3d`，squash merge
  `09033b09b2d0834f81908ed50163f91aef6b43f4`。PR 的 Documentation
  [31409575540](https://github.com/KNaiFen/happy/actions/runs/31409575540)、CLI Smoke
  [31409575111](https://github.com/KNaiFen/happy/actions/runs/31409575111) 和 Monorepo CI
  [31409582199](https://github.com/KNaiFen/happy/actions/runs/31409582199) 均成功；merge-SHA
  Documentation [31410997217](https://github.com/KNaiFen/happy/actions/runs/31410997217) 与
  Monorepo CI [31410997683](https://github.com/KNaiFen/happy/actions/runs/31410997683) 成功。
  唯一后置路由 [31412306065](https://github.com/KNaiFen/happy/actions/runs/31412306065)
  通过 source gate 与版本检测，四个 build 和四个 promotion 全部 skipped，artifact 数为零；
  同一 merge SHA 的 Field [31412302548](https://github.com/KNaiFen/happy/actions/runs/31412302548)
  与四产品 rehearsal 均成功，详细证据见阶段 2、阶段 3。
- 供应链检查与 Node.js 24 Action 升级：PR [#40](https://github.com/KNaiFen/happy/pull/40)，已于
  `2026-08-10T18:57:18Z` squash merge 为 `1278ac91a204f5326a00e74e3938c6125ab13e23`。该 SHA 的
  Documentation [31421679455](https://github.com/KNaiFen/happy/actions/runs/31421679455) 与
  Monorepo CI [31421679658](https://github.com/KNaiFen/happy/actions/runs/31421679658) 成功；主 CI
  墙钟约 54 分钟，其中 Official Codex job 2,433 秒、实际源码编译步骤 2,316 秒。后置 release
  router [31426163735](https://github.com/KNaiFen/happy/actions/runs/31426163735) 只运行一次，版本未变时
  四个 build 与四个 promotion 均 skipped，artifact 无误生成；同 SHA 的 Android Field
  [31426163792](https://github.com/KNaiFen/happy/actions/runs/31426163792) 已成功选择精确 main
  artifact，官方 Codex reusable build skipped，Android Field job 成功并上传 artifact `9078486182`；
  workflow 最终为 cancelled，但日志没有足够证据把已成功的完整 Field job 归因于 concurrency。
- Official Codex schema 5 复用：PR [#41](https://github.com/KNaiFen/happy/pull/41)，PR head
  `df57c8d5ae11d1a28b709fa3ba9113d39a0e9304`，已 squash merge 为
  `13f7b1a4e3d1202626e7608150357e6b89572750`。PR 的 Documentation
  [31429049298](https://github.com/KNaiFen/happy/actions/runs/31429049298)、CLI Smoke
  [31429048958](https://github.com/KNaiFen/happy/actions/runs/31429048958) 和 Required CI
  [31429049914](https://github.com/KNaiFen/happy/actions/runs/31429049914) 均成功；PR 因当时没有可信
  main artifact 而执行一次 fresh Codex 编译。merge-SHA main CI
  [31433827550](https://github.com/KNaiFen/happy/actions/runs/31433827550) 于 `21:26:06Z` 至
  `22:21:35Z` 成功，Official Codex 源码编译步骤耗时约 40 分 18 秒，selector 输出
  `no-trusted-main-artifact` 后上传 artifact `9081338617`、Actions digest
  `sha256:685193...1c3810`、recipe `43251e65...94856`。唯一 release router
  [31437957218](https://github.com/KNaiFen/happy/actions/runs/31437957218) 成功且四个 build/四个
  promotion 全部 skipped、artifact 数为零；对应 merge-SHA Field
  [31437957178](https://github.com/KNaiFen/happy/actions/runs/31437957178) 已精确选择该 main
  artifact 并跳过 reusable Codex build；Android Field job 于 `22:21:52Z` 至 `22:55:11Z` 成功，
  APK 构建耗时 17 分 30 秒、API 36 场景耗时 11 分 38 秒，诊断为 `phase=verified`，artifact
  [9082542260](https://github.com/KNaiFen/happy/actions/runs/31437957178/artifacts/9082542260) 的 Actions
  digest 为 `sha256:3a21bd7a...d65c527`。该 run 使用旧 workflow，只产生一份诊断 artifact，按预期
  没有新的成功 receipt。
- Field 同输入并发与 receipt 去重：PR [#42](https://github.com/KNaiFen/happy/pull/42)，PR head
  `f33a4468cbb170fcdd80a2ce33b62d50ee27dfca`，已于 `2026-08-11T01:47:57Z` squash merge 为
  `41814d01b42c3afa91a0e4c0eb6ab03050c1376d`。PR 的 Documentation
  [31449177608](https://github.com/KNaiFen/happy/actions/runs/31449177608)、CLI Smoke
  [31449177584](https://github.com/KNaiFen/happy/actions/runs/31449177584) 和 Required CI
  [31449177727](https://github.com/KNaiFen/happy/actions/runs/31449177727) 均成功，且 PR 的 Official Codex
  selector 复用 artifact `9081338617`、fresh build job 为 skipped。merge-SHA main CI
  [31450406708](https://github.com/KNaiFen/happy/actions/runs/31450406708) 成功并重新 attestation；同 SHA 的
  唯一 release router [31451157898](https://github.com/KNaiFen/happy/actions/runs/31451157898) 成功，四个 build
  与四个 promotion 全部 skipped、artifact 数为零。自动 Field [31451157897](https://github.com/KNaiFen/happy/actions/runs/31451157897)
  成功后上传 receipt `9086877640`；同 SHA 手动对照 [31451221044](https://github.com/KNaiFen/happy/actions/runs/31451221044)
  等待自动 run 后以 `reason=prior-success` 成功，Android Field job skipped，详见阶段 2 与阶段 4。
- Android Field APK producer 与运行时凭据注入：PR [#44](https://github.com/KNaiFen/happy/pull/44)，PR head
  `21d9361f3fae34a6804a8f4529224cb3030d59d5`，已于 `2026-08-11T04:27:55Z` squash merge 为
  `5be51a792bb1cc6c9471a1ba49acd49a78c7d47f`。PR 的 Documentation
  [31457748571](https://github.com/KNaiFen/happy/actions/runs/31457748571)、CLI Smoke
  [31457748567](https://github.com/KNaiFen/happy/actions/runs/31457748567) 和 Required CI
  [31457748755](https://github.com/KNaiFen/happy/actions/runs/31457748755) 均成功。merge-SHA main CI
  [31458552949](https://github.com/KNaiFen/happy/actions/runs/31458552949) 成功，自动 Field
  [31459331849](https://github.com/KNaiFen/happy/actions/runs/31459331849) 的独立 APK producer 成功构建、
  校验、上传和下游复验 APK，但 App surface 未绘制首帧。诊断证明该 APK 使用 React Native 0.83 的
  `whatwg-fetch`；客户端传入 `cache: no-store` 后，polyfill 会把 GET URL 改写为
  `/credentials?_=...`，而 loopback 服务按契约拒绝查询字符串并返回 404，初始化 catch 又保留 splash。
  PR [#45](https://github.com/KNaiFen/happy/pull/45) 随后将 `RequestInit.cache` 替换为 `Cache-Control: no-store`，
  workflow readiness 只等待服务 `ready` 日志且在 App 启动前拒绝任何请求记录，runner 则在 bootstrap Maestro
  成功后要求首个请求为精确 `GET /credentials` 的 `200`，避免把探测请求冒充 App 证据；其 merge SHA 为
  `f8418d1c43da49975e9bc11a92ed50325bad79f9`。该 SHA 的自动 cache miss Field
  [31468020054](https://github.com/KNaiFen/happy/actions/runs/31468020054) 确实完成 APK producer（job
  `93705014904`，21 分 02 秒，artifact `9092731920`，Actions digest
  `sha256:221be555d0ac3fd6ec53b685a213c4fdcdc8cd081028a973a6823f99a3046956`）及下游 APK 下载/内容复验，
  但 credential server 在模拟器启动前以 `Mobile Field credential state is malformed` 失败，没有成功 receipt。
  根因是 fixture 的 `randomBytes(32).toString('base64url')` 可产生 16 种合法末字符，而 server 和 App 都只接受
  `A/Q/g/w` 四种；该缺陷会随机拒绝约 75% 的有效 secret。PR #46 以“43 位 Base64URL、解码后恰为 32 字节、
  重编码完全相等”替代该错误集合校验，并以旧实现拒绝的 `E` 结尾向量覆盖两端；其 PR CI 全绿，merge-SHA main CI
  [31472510598](https://github.com/KNaiFen/happy/actions/runs/31472510598) 的 18 个 job 亦全部成功。其后的自动
  cache miss Field [31473619456](https://github.com/KNaiFen/happy/actions/runs/31473619456) 与显式同 SHA cache hit
  [31476678804](https://github.com/KNaiFen/happy/actions/runs/31476678804) 已完成，精确 APK 复用证据见阶段 2。
- 负责范围：`.github/workflows/`、依赖审计脚本、根/工作区依赖清单与锁文件、知识库活动计划及 GitHub 仓库治理设置。
- 版本边界：Actions、文档和索引本身不改变可分发行为。PR #57 已使用 CLI `1.4.51`、App `1.11.48`、
  Server `1.1.44` 和 happy-agent `0.1.10`；已进入发行工作流的版本不复用。本次 Tauri runtime High 修复
  将 App 提升到 `1.11.49`，仍只由既有云端发行工作流构建制品。
- 外部依赖：`main` ruleset、GitHub Actions 安全设置和真实 Android 设备验收必须在 GitHub 或外部设备上完成，不能以本地文件修改代替。

## 背景与事实证据

2026-08-10 对 `KNaiFen/happy` 的 Actions 审计采集了每个活动工作流最近最多 20 次运行，共 148 次 run、145 次终态 run。样本中有 9 组同一工作流、同一代码树的 `push -> pull_request -> main push` 三元组；若保留 PR 验收、移除两次重复 push，理论上可减少 16,682 runner 秒（约 278 分钟）。

对 Codex Android Field 最近 30 次运行（#116--#145）的独立复核显示：22 次 `push`、3 次 `schedule`、5 次
`workflow_run`，累计 job 时间 14 小时 50 分 46 秒；APK 构建与 Field 场景占 81.0%。#133/#134 与
#124/#125 是两组同一 Happy SHA 且同一 Official Codex manifest 的并发取消，已有日志证明的中止 runner
消耗为 24 分 02 秒。#144/#145 也是同 SHA、同 Codex commit/manifest 的重复完整 Field，两个 Field job
合计 1 小时 12 分 24 秒；#144 的 workflow 最终为 cancelled，但没有足够日志把其整段 job 时间全部归因
给 concurrency，因此不把它计为确定性取消浪费。旧 schema 尚未暴露 recipe fingerprint，本段以完全相同
`source.json` 摘要作为 recipe 等价证据，不外推未知字段。

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

PR 首轮云端 rehearsal 还确认旧 smoke 的 checkout 会同时掩盖 `happy-server-self-host` 全局同级安装解析和归档缺少 runtime 两个问题。Actions 阶段只校正 smoke 的真实性；可分发修复、版本提升和安装文档同步已由[归档计划](./archive/happy-server-global-package-resolution.md)完成。

### 阶段 2：变更影响规划与不可变制品复用

- [x] 为 Monorepo CI 和 CLI Smoke 增加始终运行的变更分类入口，按包依赖关系启用必要 job；聚合 gate 明确接受有意跳过的 job，但拒绝失败或取消。分类器单测覆盖 docs-only、Wire 传播、独立包和 root 输入。
- [x] 保留 Wire 变更对 CLI、Server、App、Agent 等消费者的保守传递，不做仅凭目录名的危险跳过；分类器单测验证该传播集合。
- [x] Official Codex 以解析后的 release tag、peeled commit、Rust toolchain 和 runtime marker 形成不可变指纹；CI 与 Field 复用同一已验证归档。
- [x] 将 Official Codex 复用升级为 schema 5：以 canonical recipe fingerprint（release/锁文件/实际 Rust
  工具链、runner、rusty_v8 资产、Linux 构建依赖、环境和 workflow/helper 摘要）命名 artifact；selector
  只接受同仓库 `push/main`、首轮、成功且 `Required CI gate` 成功的 main producer。PR 只读取已验证 main
  artifact；main 命中后重新 attestation 并上传到当前 run，同时保留最初编译 SHA/run 与所有二进制、Cargo.lock
  摘要。验收必须覆盖分页漂移、重复/过期/错误 workflow 候选、API/archive/manifest/二进制摘要篡改，以及
  Rust facts 在 source-declared override 后采集；target cache marker schema 4 也保留并校验最初编译
  Happy SHA/run，避免缓存命中伪造编译来源。PR #41 已将该实现合并到 main；其首个 main run
  `31433827550` 在没有可信 producer 时按预期 fresh 编译并上传 recipe artifact，PR/main/Field 的
  “复用命中”对照已由 PR #42 的 PR/main/Field 云端运行完成。
- [x] Android Field 将 App 源码指纹与 Codex 指纹分离；自动 cache miss 与同一 `main` SHA 的显式 cache hit 已证明相同 App 指纹复用已验证 APK，且不重复 Gradle 构建。
- [ ] 用新的 run 样本比较 wall time、runner time、cache restore/export 和失败定位时间，不仅比较单次绿色耗时。

当前 main 的 Field 去重实现按 `workflow_run.head_sha` 或当前 `github.sha` 建立
`cancel-in-progress: false` 的 workflow 锁；`workflow_run` 只有同仓库、`push/main`、首轮且成功的
上游 CI 才进入 selector。完整 Field job 成功后才上传
`codex-android-field-success-v1-<happy SHA>-<recipe fingerprint>` 收据，后继同 SHA run 必须验证
收据所属 workflow、run、job、artifact digest、receipt JSON、压缩包实际字节上限和 14 天有效期，才跳过 APK/模拟器；
API 不可用、候选过期/篡改、失败/取消/重跑或 recipe 改变均执行真实 Field。PR #42 的 merge SHA
`41814d01` 对照证明：自动 `workflow_run` [31451157897](https://github.com/KNaiFen/happy/actions/runs/31451157897)
从 `02:02:39Z` 至 `02:34:44Z` 成功，Android Field job 实际执行 31 分 43 秒并在 `02:33:43Z` 上传
receipt `9086877640`；同 SHA 的手动 `workflow_dispatch`
[31451221044](https://github.com/KNaiFen/happy/actions/runs/31451221044) 从 `02:03:54Z` 至 `02:35:56Z` 成功，
其 32 分 02 秒主要为并发等待，dedup 输出 `should_run=false`、`reason=prior-success`，Android Field job
为 skipped（没有 APK、emulator 或 Maestro 步骤）。自动 run 的 `cancelled_by=null` 且成功结束，证明后继不会
取消已开始的 Android job；待运行的同 SHA run 仍可能被更新事件替换，这是 GitHub concurrency 的平台语义，
但不再产生已开始 job 的 runner 浪费。

APK 复用实现拆为两个可独立判定的阶段；下述自动 cache miss 与受控同 SHA cache hit 已完成这两个阶段的云端对照：

- Field APK 不再嵌入每次 run 生成的 `EXPO_PUBLIC_DEV_TOKEN/SECRET`。显式 Field build 只允许从
  `http://127.0.0.1:53587/credentials` 获取 Compact JWS 与 32 字节 Base64URL secret；workflow 在
  emulator 上通过 `adb reverse` 暴露只绑定 loopback、`no-store` 的短生命周期服务。普通生产配置不启用
  Field 标记或提供该 URL，普通开发 build 的既有环境变量入口不变。
- App 指纹由 Git 索引中的 `packages/happy-app`、`packages/happy-wire`、root 安装清单与锁文件、patch、
  postinstall、Field workflow 和 APK build/verify/archive helper 的 mode、blob 与路径形成，再与固定 Node、
  pnpm、Java、SDK 36、build-tools、NDK、CMake、x86_64/New Architecture、OTA/HTTP/loopback 和 Gradle recipe
  做 canonical SHA-256。它明确不包含 run 级凭据、Official Codex recipe、Happy SHA 或提交时间戳；后两者
  作为实际 producer 的动态编译元数据写入 manifest，避免把内容等价复用误报为当前 SHA fresh build。
- `Build or reuse Android Field APK` 是独立 producer job。cache miss 才安装 NDK/CMake、配置 Gradle cache、
  prebuild 和 `assembleRelease`，在上传前验证包名、SDK 36、仅 x86_64、OTA disabled、loopback 配置、签名和
  16 KB zip alignment；完整 Field job 即使随后失败，成功 producer 的 artifact 仍可供后继 run 使用。
- selector 只接受同仓库、`main`、首轮、正确 workflow/path、唯一成功 producer job 与唯一未过期同指纹
  artifact；重新获取 artifact/run/jobs/run-artifacts 后回绑 ID、run、SHA、大小和 Actions digest。下载 ZIP
  上限 192 MiB、APK 上限 160 MiB、manifest/中央目录上限 64 KiB，并拒绝 ZIP64、多盘、额外/重复/穿越、
  符号链接/特殊文件、加密、高压缩比和 CRC/声明大小不一致；selector 的外层、manifest 与 APK 任一校验
  失败均回退 fresh build。消费 job 再下载一次精确 ID/digest，并重复 APK 内容检查后才运行原有 CLI、Relay、
  Official Codex、API 36 emulator、四段 Maestro 和成功收据断言；若已选 immutable artifact 在第二次下载时
  出现新的 API/传输故障则失败闭合，不在消费 job 内临时构建未经独立 producer job 证明的 APK。
- `workflow_dispatch.force_full_field` 默认关闭，只允许显式手动 dispatch 绕过完整成功收据；它不跳过任何
  APK 或 Field 检查。合并后先由自动 run 证明 cache miss/fresh build/upload/consume，再对同一 main SHA
  显式强制一次完整 Field，证明 `reason=trusted-app-fingerprint`、Gradle/NDK/CMake/build steps 全部 skipped、
  下载后的完整场景成功。未取得这两个精确 run、artifact ID/digest、producer/compiled SHA 和阶段耗时前，
  不得把源码测试或 PR CI 当作 APK 复用完成证据。

PR #46 merge SHA `b81e57609cfa5ace8a6fe3d98824dd5bbe72b264` 的自动 cache miss
[31473619456](https://github.com/KNaiFen/happy/actions/runs/31473619456) 先完成真实 APK producer：
`93722332840` 从 `08:32:29Z` 至 `08:53:10Z`，耗时 20 分 41 秒；selector 输出
`selected=false`、`reason=no-trusted-app-fingerprint`，写入 App fingerprint
`63c266ee33804a507aa4cf979fedd3999d278e0314e0e6bd0452d87ad713b898`。它上传的 APK artifact
`9094897770` 为 132,119,009 bytes，Actions digest 为
`sha256:7ce22f9692c53450b6bc5214d849a7ef821048ef39a306ebc111fa19995c4e82`；consumer
`93727188018` 从 `08:53:12Z` 至 `09:06:36Z`，耗时 13 分 24 秒，在下载和内容复验后完整通过。
成功收据为 [9095310921](https://github.com/KNaiFen/happy/actions/runs/31473619456/artifacts/9095310921)，
digest `sha256:6526b587c7d77497f992bba6e231a6bbd50c03acbb58dc8f05e1d07461d13d7d`。

同一 SHA 的显式 `force_full_field=true` cache hit
[31476678804](https://github.com/KNaiFen/happy/actions/runs/31476678804) 随后提供受控对照：producer
`93732173850` 从 `09:13:55Z` 至 `09:14:20Z`，仅 25 秒，selector 输出
`selected=true`、`reason=trusted-app-fingerprint`，并回绑同一 artifact ID/digest 与
`compiled_happy_source_sha=b81e5760...`。Gradle、NDK/CMake、依赖安装、Wire 构建和 APK assemble
步骤均为 skipped；consumer `93732284748` 仍从 `09:14:29Z` 至 `09:28:43Z` 运行 14 分 14 秒的
下载复验、Relay、API 36 emulator 与四段 Maestro。诊断 artifact
[9095966518](https://github.com/KNaiFen/happy/actions/runs/31476678804/artifacts/9095966518) 显示 readiness
之后的首条 credential 记录为精确 `GET 200`、`phase=verified`、`providerRequestCount=8` 与
`v4LifecycleCompleted=true`；新的成功收据 [9095963589](https://github.com/KNaiFen/happy/actions/runs/31476678804/artifacts/9095963589)
的 digest 为 `sha256:039bdd72b673663395086ec76e80511dbe96724a7d8823f1805c5f43ba08dda7`。这组配对样本使
producer 墙钟减少 20 分 16 秒，但不能替代 B6 所需的长期 P50/P90 采样。

历史实现（PR #35，schema 4）的路径只改变 `main` 的 Field 输入：Field 改由 `Happy monorepo CI` 完成事件
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

当前分支的 schema 5 实现以 artifact 名 `official-codex-linux-x64-r3-<recipe fingerprint>` 区分完整
编译配方；PR 只选择已通过首轮 main `Required CI gate` 的 producer，main 命中后重新写入当前
attestation 并上传到当前 CI run。源码 fresh build 会把 `compiledHappySourceSha/compiledRunId`
写入 target marker；缓存命中必须读取并校验这两个字段，随后在 `source.json` 中继承它们，旧 marker
或非法 provenance 会失效并重新编译。这样可以同时证明“当前 run 的 attestation”与“二进制最初实际编译
来源”，不把缓存命中误报为当前 run 编译。

这是一组可复现的跨 run 功能验收而非长期性能结论：该 Field job 用时 1,690 秒，较 PR #34 的
1,934 秒少 244 秒，但 Android 构建和共享缓存仍会造成波动。阶段 2 的性能项保留，必须按验收矩阵
重新采样，不能把这一次绿色结果外推为 P50/P90。

PR #39 merge SHA 的 Field [31412302548](https://github.com/KNaiFen/happy/actions/runs/31412302548)
再次证明跨 run 复用：selector 从 main CI
[31410997683](https://github.com/KNaiFen/happy/actions/runs/31410997683) 精确选择 artifact
`9071605655`，Actions digest 为
`sha256:eb90da2f12eaf7268e30954a1d3699377d4445e354a7d1b42d19a9683ee2fe6c`；
Field 的 reusable Official Codex build job 为 skipped。API 36 job 用时 2,002 秒，四个场景均成功，
最终日志为 `phase=verified`、rollback `succeeded/none`；诊断 artifact
[9073048327](https://github.com/KNaiFen/happy/actions/runs/31412302548/artifacts/9073048327)
成功上传。该 run 仍构建 x86_64 Field APK，故只增加第二个绿色功能样本，不关闭 App 指纹复用、
P50/P90 或实体 ARM64 验收。

### 阶段 3：全局门禁与发行提升

- [x] 让 Monorepo CI、CLI Smoke 和 Documentation 在所有目标 PR 上产生终态检查；重型 job 通过分类器按需跳过，聚合检查保持稳定名称。PR #31 的 docs-only 对照已验证这一行为。
- [x] GitHub `main` ruleset 要求 PR、分支最新、禁止直接 push，并限制管理员 bypass；ruleset `20624143` 要求 `Required CI gate`、`CLI Smoke gate` 和 `Generated indexes and links`，均绑定 GitHub Actions integration `15368`，且 `bypass_actors=[]` / `current_user_can_bypass=never`。未制造无语义的 root-only PR；根安装输入的分类行为由单元测试和 PR #30 的 workflow/scripts 代码路径覆盖。
- [x] 自动 release router 只在同一 SHA 的首轮全局 gate 成功后进入版本分类；PR #37 的失败路径与 PR #38/PR #39 的成功且未变版本路径分别证明 fail-closed、唯一 router、八个 skipped 和零制品；四类真实候选由下一项的独立 rehearsal 验收。
- [x] CLI、Android、Relay、happy-agent 的候选 build/promotion 各取得一次同 SHA 成功 gate 后的真实云端证据。
- [x] 将“构建候选物”与“提升可交付物”分离；promotion 只消费既有 artifact ID/digest、不重新构建，并在解压前执行资源与路径门禁；四产品 rehearsal 已证明候选与 promoted payload 逐字节相同。
- [ ] Android 上传独立 checksum/attestation；所有正式制品记录 source SHA、版本、摘要、保留期和下载入口。
- [x] 为 release workflow 自身和打包脚本增加不发布的 `workflow_dispatch` rehearsal 路径；PR #39 已合并，四产品均完成一次精确 merge SHA 的成功云端运行。

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
通过 rerun 复用已经进入发行编排的版本。PR #37 的 merge-SHA CI 失败后，路由只产生六个 skipped
job 且没有 artifact，证明失败闭合逻辑生效；PR #38 的 merge SHA 又通过同一 source gate，版本检测
确认四个版本均未变化，四个构建和四个 promotion 均 skipped，artifact 总数为零。二者共同证明路由
会失败闭合且不会对未变版本误发制品，但仍不能替代真实候选 build/promotion 验收。

PR #38 把四个 build workflow 的输出改为 7 天候选 artifact：候选清单固定包含
schema、产品、版本、source SHA，以及每个 payload 的文件名、大小和 SHA-256。Reusable workflow
向 router 暴露精确 artifact ID、Actions digest 和 source-bound 名称；promotion 再从 Actions API
按 ID 读取同一 router run 的 metadata，比较 upload output 与 API digest，下载 ZIP 并复算 ZIP
SHA-256，且 promotion receipt 强制这两个摘要相等；在解压前拒绝额外或危险路径，解压后复算清单
与 payload。只有全部一致时，才把同一
payload 连同 promotion receipt 上传为 30 天正式下载入口；promotion job 不运行 pnpm、Gradle、
Docker、pack 或任何构建命令。PR #39 又把 ZIP 中央目录校验与提取交给 Python 标准库：先拒绝
ZIP64、多磁盘、异常条目数和超过 64 KiB 的中央目录，再构造 `ZipFile` 并拒绝
额外/重复/穿越/符号链接/加密/高压缩比条目；预检与解析使用同一文件描述符，随后在临时目录中
按声明大小流式提取，成功后原子改名；
CLI、Android、Relay、Agent 的下载 ZIP 上限分别为 256/192/384/32 MiB，对应单一主 payload
上限为 192/160/320/16 MiB，并由一份结构化策略同时驱动 Node 下载器和 Python 解压器。
Android rehearsal 首次取得真实未压缩 APK 大小 `125,068,159` 字节，已占旧 128 MiB 上限约
93.2%；当前分支据此把 Android payload 上限调整到 160 MiB，使占用降至约 74.5%，并用回归测试
要求该已观测 APK 保持在门槛 80% 以下。下载 ZIP 上限保持 192 MiB，不随之放宽。
Node 下载器把 Actions metadata 限制在 1 MiB 并只接受流式正文，不使用无界 `json()` 或
`arrayBuffer()` 回退；候选 ZIP 也按产品上限流式读取。Metadata API 禁止自动重定向；ZIP API
入口携带 GitHub token，但后续最多 5 个重定向逐跳要求 HTTPS 且不得含 userinfo，并永久移除
`Authorization`，错误也不回显带签名的 `Location`。历史 CLI artifact
`9040323027` 的 API 大小与实际下载 ZIP 均为 105,350,356 字节，且 ZIP 普通文件属性可被新解析器接受。
发行与提升链的 checkout、pnpm、Node、Android/Gradle、Docker、Trivy 和 upload-artifact 均固定到完整
提交 SHA，checkout 设置 `persist-credentials: false`，正式上传改用 `upload-artifact v7.0.1`。
实现已有 promotion Node 18 项、Python 18 项源码测试，覆盖摘要不一致、超限/非流式 metadata、每一跳不安全或
过多重定向、非成功响应体取消、ZIP64、多磁盘、异常 EOCD/中央目录边界、悬空或竞态目标路径，并证明
FIFO 输入会快速失败、EOCD 失败发生在 `ZipFile` 构造前、路径替换不会改变已打开的归档、候选目录
不会覆盖竞态创建的目标，且损坏的 DEFLATE 数据会归一化为受控错误并清理暂存输出。四产品
不发布 rehearsal 已证明相同路径可用；真实 patch 版本的正式 release 仍须在实际版本变化时按发行
规则验证，不能为了计划制造版本或 Release。

PR #39 把 router 中四份相同的下载、解压、验证、写收据和上传 job 收敛为一个
`workflow_call` promotion；正式路由传入 `mode=release` 与 30 天保留期，手动 rehearsal 传入
`mode=rehearsal` 与 1 天保留期。收据 schema 2 强制模式、source/run-bound 名称和保留期一致，
因此 rehearsal artifact 不能使用正式交付名称。手动入口每次只接受一个产品，要求精确 merged-main
SHA 和对应首轮成功 Monorepo CI run ID，并复用相同 build 与 promotion workflow；其聚合 gate 要求
被选产品的 build/promotion 成功、另外三条路径全部 skipped。四个 rehearsal 都绑定 merge SHA
`09033b09b2d0834f81908ed50163f91aef6b43f4` 与同一首轮成功 main CI
[31410997683](https://github.com/KNaiFen/happy/actions/runs/31410997683)：

| 产品 | Rehearsal run | Candidate artifact / ZIP digest | Promoted artifact / ZIP digest | Payload SHA-256 |
| --- | --- | --- | --- | --- |
| happy-agent `0.1.9` | [31412492307](https://github.com/KNaiFen/happy/actions/runs/31412492307) | `9072235698` / `41ffe6b7...00093` | [9072243076](https://github.com/KNaiFen/happy/actions/runs/31412492307/artifacts/9072243076) / `e3c53057...3b90b` | `65834acb...9d4b` |
| CLI `1.4.49` | [31412492650](https://github.com/KNaiFen/happy/actions/runs/31412492650) | `9072257481` / `28856206...36f37` | [9072272915](https://github.com/KNaiFen/happy/actions/runs/31412492650/artifacts/9072272915) / `22856b3f...f64e7` | `d14f20d8...ce57a` |
| Relay `1.1.41` | [31412493200](https://github.com/KNaiFen/happy/actions/runs/31412493200) | `9072780408` / `8b4bfa64...743e` | [9072801496](https://github.com/KNaiFen/happy/actions/runs/31412493200/artifacts/9072801496) / `a84bf216...2b4e` | `e306962b...84f8` |
| Android `1.11.45` | [31412492484](https://github.com/KNaiFen/happy/actions/runs/31412492484) | `9073056833` / `0050494e...31ea` | [9073091937](https://github.com/KNaiFen/happy/actions/runs/31412492484/artifacts/9073091937) / `61b6e0fd...11bd` | `43c56527...d4c0` |

四份 candidate manifest 与 promotion receipt 的 product、version、source SHA、artifact ID、API/ZIP
digest、模式和 1 天保留期一致；本地从 GitHub 下载候选与 promoted ZIP 后逐字节比较，各产品 payload
完全相同。Relay run 还暴露一个由 `docker/build-push-action` 默认上传、保留 90 天的额外
`.dockerbuild` artifact `9072783780`；当前分支设置 `DOCKER_BUILD_RECORD_UPLOAD=false`，须由新 main
的 Relay rehearsal 证明 artifact 数从三个降为预期的 candidate + promoted 两个。

### 阶段 4：Field 稳定性、队列与失败前移

- [x] 用 Happy SHA + Official Codex recipe 指纹消除同输入的运行中取消与成功后重跑；PR #42 的 merge-SHA `workflow_run` + 同 SHA `workflow_dispatch` 对照证明已开始 Field 不被取消、成功 receipt 后继会跳过 APK/模拟器。下一次 daily schedule 继续作为生产事件样本采集，但不阻塞该实现验收。
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

Field 并发基线复核：最近 30 次 run 中，#133/#134 与 #124/#125 的日志明确证明同 SHA 的后继运行
取消前序 Android job，合计浪费 24 分 02 秒 runner 时间；#144/#145 的同 SHA、同 Codex
manifest 重复完整执行，两个 Field job 合计 1 小时 12 分 24 秒。该证据支持先治理运行中取消和
同 recipe 成功后的重复；不把旧 run 的最终 `cancelled` 结论单独当作完整 job 浪费证明。

PR #42 的精确云端对照关闭了这一实现项，而不外推为长期性能结论。自动 `workflow_run`
[31451157897](https://github.com/KNaiFen/happy/actions/runs/31451157897) 的 selector 选择同 SHA main CI 的
Official Codex artifact，reusable build skipped，`Check prior successful Android Field receipt` 首次输出
`no-prior-success` 后执行完整 API 36 Field 并上传 receipt `9086877640`。手动
`workflow_dispatch` [31451221044](https://github.com/KNaiFen/happy/actions/runs/31451221044) 在自动 Field
已开始后进入同一 SHA 锁，未取消前者；receipt 可用后它的 dedup job 验证该 artifact 并输出
`should_run=false`、`reason=prior-success`，Android Field job `steps=[]`。这同时证明 receipt 只在完整
成功后才消除重复，不以“queued”或“running”状态冒充成功。

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

- [x] 全部 12 个 workflow 的 113 个外部 Action 均固定到完整 commit SHA，36 个 checkout 均设置 `persist-credentials: false`；常驻 CI 的源码测试会拒绝可变引用和遗漏凭据关闭的 checkout，包括以 `id`/`if` 等合法键开头的步骤。
- [x] 新增仅维护 GitHub Actions 的 Dependabot 周更配置，minor/patch 合并为一组且最多同时打开 5 个 PR；它不等同于仓库级 Dependabot security updates。
- [x] 在 PR #42 与其 merge-SHA main 上验证 Node.js 24 Action 升级仍保留上传、下载、摘要、缓存和失败诊断语义；main CI、Field 与 release router 的相关日志未出现 Node.js 20 Action runtime 警告，Field receipt 上传/下载与 Official Codex artifact 重用均成功。
- [x] 维护者已决定保留 `allowed_actions=all` 与完整 Action SHA 强制；不引入 allowlist。现有 secret scanning、push protection、Relay Trivy/SBOM 保持不变。
- [x] 实现并验收 npm Dependabot、GitHub vulnerability alerts/automated security fixes、advanced CodeQL 与
  npm 生产 High/Critical 依赖门禁；`Required CodeQL gate` 已进入 active ruleset。Dependency Review 不作为
  required gate，因为其范围会扩大到开发依赖，超出本计划的已批准策略。实现细节见
  [ADR-006](../decisions/ADR-006-actions-security-and-production-dependency-gates.md)。
- [x] 修复 Tauri runtime High `GHSA-82j2-j2ch-gfr8` 以及新门禁发现的 `bytes`、`quick-xml`、`rkyv`
  漏洞，并在云端 Tauri job 以固定 `cargo-audit 0.22.2` 和 `severity_threshold = "high"` 覆盖 Cargo
  生产依赖；有 CVSS 的 Medium/Low 与纯信息性 `unmaintained`、`unsound`、`notice`、`yanked` 不得提升为
  本次已批准门禁，无 CVSS vulnerability 因无法证明低于 High 而 fail closed，且不得为 High 添加例外。
- [ ] 在真实 ARM64 目标设备上安装生产签名 APK，验证升级安装、真实网络切换、relay reconnect 与关键 Codex 生命周期；保留精确 workflow、artifact 和设备证据。
- [x] 当前无自动生产部署；GitHub Environment、部署审批、发布后健康检查与回滚门禁不适用。若未来引入部署目标，必须先按 ADR-006 新增明确决策与演练。

PR #39 的 main Field 和 Android rehearsal 均在终态汇总中报告：`actions/setup-java@v4`、
`actions/upload-artifact@v4`、`android-actions/setup-android@v3`、
`gradle/actions/setup-gradle@v4` 仍目标 Node.js 20，只是由 GitHub 强制在 Node.js 24 上运行。
当前分支把这些引用升级到 setup-java `v5.7.0`、upload-artifact `v7.0.1`、setup-android
`v4.0.1`、setup-gradle `v6.3.0`；CLI Smoke 同时升级 download-artifact 到 `v8.0.1`。
checkout `v7.0.1`、setup-node `v7.0.0`、pnpm/action-setup `v6.0.10` 和 setup-bun `v2.2.0`
也固定到经上游 tag 复核的精确 commit。Action 自身要求 GitHub Actions Runner `>=2.327.1`，
本仓库只使用 GitHub-hosted runner，没有 self-hosted 兼容性阻塞。

2026-08-12 的仓库设置与维护者决策为：Actions 已启用、`allowed_actions=all`，且
`sha_pinning_required=true`；维持该策略，不新增 allowlist。2026-08-14 的 GitHub API 复核确认
Dependabot security updates 已启用，ruleset `20624143` 已要求 `Required CodeQL gate`，PR #57 的
CodeQL 与 main CodeQL 均成功。
Dependency Review 对精确 base/head 的 `403 Forbidden` 不阻塞本计划，因为该检查不在已批准的
生产 High/Critical 审计范围内。当前 GitHub Environment 数量为零且无自动生产部署，故不建立
虚假的审批/回滚流程。Secret scanning 与 push protection 已启用，ruleset `20624143` 保持 active
且没有 bypass actor。上述仓库设置不由源码 PR 隐式修改，必须记录设置 URL、操作者和时间证据。

同日从 `origin/main@ec111f88` 执行的 npm production audit 通过，只接受两个无修复版本、路径和到期日均
精确受限的 `image-size` 临时例外。GitHub alerts 另显示 Tauri `Cargo.lock` 有一个 runtime High：
`rustls-webpki 0.103.4` 的 `GHSA-82j2-j2ch-gfr8`，修复版为 `0.103.13`，现有 Dependabot PR #55 已选择
`0.103.14`。五个自动更新失败均已定位为当前约束无法解析修复版：`tauri`、`time`、`glib`、
`serde_with` 为 Medium，`rand` 为 Low；它们保持可见但不冒充本次 High/Critical 阻断项。

独立修复 PR [#58](https://github.com/KNaiFen/happy/pull/58) 的 head `03c161cb` 通过 CI
`31780241640`、CodeQL `31780241507`、Documentation `31780241514` 和 CLI Smoke `31780241541`，并于
`2026-08-14T07:59:17Z` squash merge 为 `eb6111f0`。同 SHA 的 main CI `31782083553`、CodeQL
`31782083429` 和 Documentation `31782083435` 均成功；main Tauri job 使用 Rust `1.88.0`，固定安装
`cargo-audit 0.22.2` 后完成 audit、format、check 与 test。发行 run `31783096096` 生成并提升 App
`1.11.49` artifact `9213041500`（`happy-app-1.11.49-android-arm64-v8a-no-ota`，69,876,772 bytes）。
Dependabot alert #123 于 `2026-08-14T07:59:24Z` 标记为 fixed。

## 当前阻塞项

| 编号 | 当前证据与影响 | 下一步 | 完成标准 |
| --- | --- | --- | --- |
| B2：仓库级 Action allowlist（已解决） | API 为 `allowed_actions=all`、`sha_pinning_required=true`；维护者已决定保留该策略。 | 无后续实现；继续由完整 SHA 固定、最小权限和 CI 测试补偿。 | ADR-006 与仓库 API 一致；不把“未使用 allowlist”误写成供应链控制缺失。 |
| B3：依赖与 SAST 门禁（已解决） | npm 与 Cargo 生产审计、alerts/security fixes、advanced CodeQL 和 ruleset gate 已生效；PR #58、main Tauri 与 App `1.11.49` 已证明 `rustls-webpki` High 及新增 5 项 Cargo 漏洞修复，Dependabot #123 已 fixed。 | 维持固定 cargo-audit High/Critical 与无 CVSS vulnerability fail-closed 门禁；在 2026-11-12 前复核两个 Metro 无修复例外。 | npm 与 Cargo 的生产 High/Critical、无 CVSS vulnerability 新发现均 fail-closed；有 CVSS 的 Medium/Low 和纯信息性类别不升级；两个精确 Metro 无修复例外在到期前可见且受限。 |
| B4：Environment/部署边界（已解决） | 当前无 Environment、Deployment 或 Pages 自动生产部署；维护者确认保持 build-only。 | 不配置虚假的 deployment approval；未来先新增 ADR，再实施环境、审批、健康检查和回滚。 | ADR-006 明确 build-only 边界，计划不再将 Environment 当作当前门禁。 |
| B5：Android 独立证明与实体设备 | Rehearsal 已验证签名 ARM64 APK、source/digest receipt 和 payload 不变，但没有独立 checksum/attestation 下载项，也没有 Snapdragon 8 Elite 实体设备证据。 | 在正式 Android 发布路径增加独立 checksum/attestation；由具备生产设备、签名 Secret 和真实网络条件的操作者执行设备矩阵。 | 正式 artifact、checksum/attestation 绑定同一 SHA/版本；实体设备完成升级安装、网络切换、relay reconnect 和关键 Codex lifecycle，留下设备/运行/制品证据。 |
| B6：长期性能与取消率 | 现有数字只覆盖少量绿色 run；main CI `31410997683` 墙钟 922 秒、runner 2,271 秒，TUI 占 runner 34.7%，但不足以宣称 P50/P90。 | 累积至少 20 次 CI/Field/Smoke 样本，按 workflow、job、cache 与失败阶段重新统计。 | 报告 wall/runner P50/P90、cache 命中、取消率、重复 run 和失败阶段；仅保留有持续收益的缓存/复用优化。 |
| B7：后续实现工作 | PR #46 已关闭 canonical secret 缺陷；自动 miss `31473619456` 与显式同 SHA hit `31476678804` 已证明 APK App 指纹复用、严格下载复验、readiness 无请求、App 首个无 payload `GET 200` 与完整 Field 断言。APK 子项不再阻塞。Relay 前移检查、超 SLA 告警和 Relay cache mode A/B 仍未实现。 | Relay 前移、SLA 与 cache A/B 分别使用独立 PR；daily schedule 只作为 B6 的新增样本。 | Relay 早失败不删除最终 bundle 验收；超 SLA 有终态告警；cache A/B 有持续 runner/wall 收益。 |

## 验收矩阵

### 本地源码级验证

```bash
node --check scripts/docs/knowledge-base.mjs
node --check scripts/ci/official-codex-artifact-reuse.cjs
node --check scripts/ci/official-codex-artifact-reuse.test.cjs
node --check scripts/ci/android-field-run-dedup.cjs
node --check scripts/ci/android-field-run-dedup.test.cjs
node --check scripts/ci/android-field-apk-reuse.cjs
node --test scripts/ci/official-codex-artifact-reuse.test.cjs
node --test scripts/ci/android-field-run-dedup.test.cjs
node --test scripts/ci/android-field-apk-reuse.test.cjs
node --test packages/happy-app/mobileFieldConfig.test.cjs
node --test scripts/ci/mobile-field-credential-server.test.cjs
node --test scripts/ci/codex-mobile-recovery-launch.test.cjs
node --test scripts/ci/workflow-action-security.test.cjs
node --test scripts/ci/verify-release-source-gate.test.cjs
node --test scripts/ci/release-candidate-promotion.test.cjs
python3 scripts/ci/release_candidate_archive_test.py
python3 scripts/ci/android_field_apk_archive_test.py
pnpm --filter happy-app exec vitest run sources/sync/mobileFieldCredentials.spec.ts sources/sync/devE2eBootstrap.spec.ts
pnpm --filter happy-app typecheck
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
- 同 SHA 的自动 `workflow_run` Field 成功 receipt 后，后继 `workflow_dispatch` 或 schedule run 必须保留
  `reason=prior-success` 与 skipped Android Field job；在 receipt 不存在、过期或校验失败时必须执行真实 Field。
- APK 复用首次验收已由自动 cache miss `31473619456` 与同 main SHA 的显式
  `force_full_field=true` cache hit `31476678804` 满足；hit 只跳过 APK 构建相关步骤，仍重复 provenance、
  APK 内容、模拟器和完整 Field 断言。自动 miss readiness 未请求 `/credentials`，且 App bootstrap 后记录首个
  `GET 200`。默认手动、定时与自动事件仍不得绕过成功收据；未来变更 App 指纹契约时必须重新取得同等对照。
- ruleset、Actions 安全设置和真实设备验收记录管理员、时间、URL 与结果，不以计划勾选代替外部证据。
- 完成后重新采样至少 20 次相关 workflow，报告重复 run、runner 分钟、wall P50/P90、取消率和失败阶段分布。

## 风险与回滚

- GitHub path filter 和 required check 组合可能造成检查永久 pending；在 ruleset 生效前必须用 root-only、docs-only 和代码 PR 验证。
- Linux 生成的 CLI/Wire 归档应为平台无关；Windows 四矩阵腿会提供实际安装证据。若归档不可移植，回滚 prepare 复用，不得跳过 Windows 检查。
- Artifact 下载可能抵消小型 job 的准备收益；只在云端 runner 数据证明有效时继续推广到 Monorepo CI。
- TUI 真实时序和 Field recovery 不能用缩短 sleep 或扩大 timeout 掩盖；优化应来自触发范围、确定性测试和制品复用。
- 任一工作流修复若导致门禁缺席、错误跳过或制品来源不明，应回滚该阶段的独立提交，不继续推进后续阶段。

## 下一步

1. 为 Android 正式交付增加独立 checksum/attestation，并安排 B5 的实体 ARM64 设备验收；本次
   x86_64 Field 和 rehearsal 不能替代物理设备、生产网络或外部账号证据。
2. 重新采样至少 20 次 Official Codex CI/Field/Smoke，报告 runner/wall P50/P90、cache 命中、取消率
   和失败阶段；在有足够样本前不把单次 run 差值宣称为长期节省。
3. APK 复用的 automatic miss/hit 对照已经完成；接下来依次以独立 PR 处理 Relay 失败前移、超 SLA
   告警和 cache mode A/B。Field 同输入并发已经过云端对照，每项后续优化仍以独立云端对照证明，不删除
   最终交付验收。
4. 不制作无语义 root-only PR；下一次真实 root 安装输入变更必须记录其分类器和两个 gate 的云端结果。

## 完成条件

- [ ] 五个阶段均有实现提交、精确 GitHub run 或外部设置证据。
- [ ] 同一 PR 不再出现分支 push、PR 和等价 main tree 的三次全量 CI。
- [ ] docs-only 变更不运行代码、打包或 Android Field；root 打包输入不会漏掉 CLI Smoke。
- [ ] 所有正式 release 制品都在同一 SHA 的全局 gate 后由既有 digest 提升。
- [ ] Field 的取消率和真实失败已分别治理，实体 ARM64 验收仍有可追溯证据。
- [ ] 活动计划更新为已完成并移入 `docs/plans/archive/`，生成索引与本机记忆同步收尾。
