# CI 覆盖、稳定性与交付成本优化实施记录

## 状态

状态：实施完成，交付中；PR #73 的实现提交已通过全部必要门禁及真实官方 Gateway 验收，合并后 main、Android Field 和正式补丁交付待执行。

2026-09-08 已完成只读调查及方案编制；本文件不是实施或云端验收完成记录。

- 负责人：当前任务主代理。
- 当前授权：用户已要求“开始执行PLAN”，随后追加“兼容性修复与必要补丁交付”；覆盖 A1-A5、B1 修复、必要 CI、既定 PR 交付及受影响 CLI 补丁下载与本机更新。
- 当前分支：`ci/coverage-runtime-optimization-20260908`；A1-A5 为 `d5d6cee2`，B1 为 `f77297a7`，后续兼容修复截至 `aa0ddbc0`；PR #73 主 CI 尚未通过，交付待完成。
- 下一步：完成最终 PR 门禁后合并，核对精确 main、Android Field 与正式补丁交付；最终结果写本机记忆，不为补记本次 CI 再提交。
- 独立使用 `gkd-optimize-ci`；不额外建立同义报告、GKD 角色或流程记录。

## 目标与成功标准

1. 当前文档、删除、跨包改名和已声明的构建输入进入正确检查；纯归档继续只运行必要轻量检查。
2. 选中任务失败、取消或未执行时，聚合门禁不能通过；无关变更能完成全部 required checks。
3. watchdog 不因 `workflow_run` 上下文 SHA 相同而把不同业务源的排队任务当成重复运行。
4. 每个适用 job 内只构建一次 Wire；外部依赖安装有独立超时，保留失败退出和完整构建输入校验。
5. 用精确提交、事件、attempt、环境和复用状态记录验证结果；实现正确性与尚待观察的提速效果分别报告。
6. 交付前已知的计划整理与实现同行；合并后事实不提前填写，也不为回填本次归档提交或 CI 结果循环补交。

## 基线、环境与证据

调查时间：2026-09-08，远端运行主采样窗口为 14:12-14:21 UTC，随后进行了同日关键事实抽查。
远端 `main` 为 `8521f1a4a473ed10cc6a7bd9ee99b142fc27c054`；调查时本地
`b9693ba822b8ec6cdb04fb2789b9930f00b6edc9` 与其文件树一致。实施前重新确认基线，不将历史行号当成不变定位。

| 项目 | 已核验事实与执行安排 |
| --- | --- |
| 本机 | MacBook Air M4，ARM64，16 GB，macOS 26.5.1；APFS 约 245 GB，总容量属于 256 GB 档，可用约 112 GB |
| 本地工作 | 文档、Git、Node 分类器与契约测试、必要 `tsc --noEmit`；不安装发布工具链，不构建官方 Codex、Android、Docker、Web、Rust/Tauri 或打包产物 |
| 云端 | 公开仓库 `KNaiFen/happy`；使用现有 GitHub 托管标准 Linux、macOS、Windows runner 和官方镜像 |
| 资源限制 | 不采用 larger、自建 runner 或自定义镜像；账号并发额度和实际排队原因未取得，不声称排队为零 |
| 缓存 | 同日 API 显示 8 个缓存，共 8,957,061,067 字节，约 8.34 GiB；三个官方运行时缓存各约 2 GiB，未取得缓存抖动证据 |
| 发布版本 | CLI 1.4.54、App 1.11.55、Relay 1.1.46、happy-agent 0.1.11、Wire 0.1.8；CI、测试和文档改动不升包版本 |

公开仓库的标准 runner 分钟免费，但存储和并发仍有限制，参见
[GitHub 计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)及
[Actions 限制](https://docs.github.com/en/actions/reference/limits)。不把累计 job 时间转换成账单金额。

主要证据入口：

- [主 CI](../../../.github/workflows/ci.yml)：基线第 4-35 行为触发和并发，第 67-76 行为比较输入，第 898-987 行为聚合门禁。
- [影响分类器](../../../scripts/ci/classify-workflow-changes.cjs)：`classifyPaths` 第 213 行、Markdown 排除第 221 行、`changedPathsBetween` 第 298 行。
- [provider 检查](../../../scripts/ci/assert-codex-only-provider.cjs)：`activeDocs` 第 18 行；[postinstall](../../../scripts/postinstall.cjs)第 11-18 行为 Wire 构建开关。
- [watchdog](../../../scripts/ci/actions-sla-watchdog.cjs)：`WORKFLOW_SLA` 第 6 行、`laterRun` 第 53 行、`decideCancellations` 第 61 行。
- [官方源码构建](../../../.github/workflows/build-official-codex-source.yml)：第 158 行为 Linux 依赖安装，第 319 行起查找可信产物。
- [发布来源验证](../../../scripts/ci/verify-release-source-gate.cjs)：`validateSourceRun`、`validateRequiredGate`、`validateMergedPullRequest`。

只读取证命令包括 `gh api repos/KNaiFen/happy/rulesets/20624143`、按 workflow 查询
`actions/workflows/<workflow>/runs?per_page=15`、选定 run 的 `/jobs` 和 `/attempts/<n>/jobs`、
PR `/files`、`/commits`、`actions/cache/usage` 及 `actions/caches`。未下载大型日志或制品。
本地通过直接调用分类器确认 README 未选择 provider 检查，并以合成数据确认 watchdog 使用上下文 SHA 判重；后者不是误取消生产实例。

## 合并门槛与不可变边界

[规则集 20624143](https://github.com/KNaiFen/happy/rules/20624143)实际启用，无 bypass，要求 PR、解决 review threads、分支保持最新，以及：

- `Required CI gate`
- `CLI Smoke gate`
- `Generated indexes and links`
- `Required CodeQL gate`

当前无合并队列，因此不新增 `merge_group`。保留 PR 必需工作流的稳定入口及 `always()` 聚合判定，
不能以整个 required workflow 的路径跳过代替 job 分类，参见
[GitHub 必需状态检查说明](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)。

本地“直接推送 main”指令与实际 PR 规则冲突；发布验证器也要求源 SHA 对应恰好一个已合并 PR。
本 PLAN 的获批实施交付走 origin 功能分支及 PR，保留 main 的精确源 CI 与发布来源校验。
用户的执行批准覆盖该交付安排；不修改本地规则或平台门槛，不绕过门槛。

保留官方 stable-v2、真实 app-server/Relay/App/恢复验收、Gateway 的 11 分钟 Presence 存活断言、
发布候选 digest/manifest/源关联、首次 attempt 契约、Android ARM64 签名与身份校验，以及现有依赖门禁。
不深入漏洞调查，不修改签名、凭据、部署或付费资源设置。

## 变更覆盖与 DAG

| 变更 | 当前行为 | 首轮目标 |
| --- | --- | --- |
| 纯归档、普通 Markdown | 文档检查和稳定分类/聚合任务；重型任务跳过 | 保持 |
| `activeDocs` 中的文档 | 与普通 Markdown 相同，漏掉声明的 provider 文档检查 | 增加轻量 provider 检查，覆盖 PR 与 main 入口 |
| 删除、改名 | 删除参与分类；已识别改名仅保留目标路径 | 按删增保留两端，选中源包和目标包 |
| CLI、Server、App 等源码 | 本包及现有保守集成集合 | 首轮保留现有业务检查集合 |
| Wire | 关联消费者、协议和集成检查 | 保持 |
| 根锁文件、workspace、安装配置、patches | 全范围检查 | 保持 |
| `happy-app-logs/package.json` | 分类器选择 Server 等，main 外层 paths 未包含 | 补齐 main 入口，与现有分类器一致 |
| Workflow、CI 脚本 | 契约检查及明确映射的场景 | 校验本次修改入口，补齐必要既有场景映射 |
| 混合变更 | 非 Markdown 检查的并集 | 所有相关输入的并集，文档不抵消源码影响 |

```text
PR/main 变更分类
  +-- 包检查、契约、协议、迁移、provider、依赖门禁 --+
  +-- 官方 Codex 构建/可信复用                       |
        +-- app-server lifecycle                    +--> Required CI gate
        +-- Gateway PTY + 11 分钟 Presence ----------+

独立工作流：Smoke 分类 -> prepare -> Linux/Windows x Node 20/24 -> Smoke gate
            CodeQL 分类 -> 四语言并行 -> CodeQL gate
            文档索引与链接检查

main CI 成功 -> 精确源与 PR 验证 -> 版本判断 -> 四产品并行构建 -> 分别晋升
main CI/定时 -> Field 选源/官方源码 -> receipt 去重 -> APK 构建/复用 -> API 36 场景
```

首轮不增加全局串行快速检查层，以免正常运行受额外依赖阻塞。低成本失败当前已能提前出现，
聚合门禁等待所有选中 job；是否让昂贵任务等待特定快速检查，留待独立诊断收益与成本有证据后决定。
Smoke 保留现有默认 matrix fail-fast，CodeQL 保留 `fail-fast: false`。
PR 旧验证按现有并发组取消；不同 main SHA 与发布任务继续保留，不能统一开启取消旧运行。

## 首轮实施范围

### A1 / P0：补齐文档、改名与入口覆盖

- 修改影响分类器、CodeQL 分类器、provider 检查的最小导出边界及相应现有测试；修正 `ci.yml` 的 main paths。
- 复用 `activeDocs` 的单一权威集合，禁止为 CI 再维护一份容易漂移的文档清单；直接导入时确保不会执行检查主程序。
- 两个 `changedPathsBetween` 使用 `git diff --no-renames --name-only -z`，将移动视作删增，保留现有非法 SHA 全选和 Git 失败退出。
- main 输入加入已声明的 `happy-app-logs/package.json`；文档过滤只放开真正需要 provider 检查的入口，不为归档启动安装或业务构建。
- 收益：恢复真实输入覆盖。风险：比当前多选必要源包或文档检查。验证：覆盖表、跨包改名、源码改名为 Markdown、删除、混合修改及聚合失败传播。
- 回滚观察：关注漏选、required check 长期 pending 或归档意外启动重型任务；修正具体映射，不取消门禁。

### A2 / P0：避免 watchdog 误判 workflow_run 重复

- 修改 `actions-sla-watchdog.cjs` 的 `laterRun`/输入约束及其现有测试；契约入口同步覆盖改动。
- 仅对 `push`、`pull_request`，且事件、workflow、ref/分支、源 SHA 均一致的排队运行按 `superseded-same-sha` 判重。`workflow_run`、可能携带不同 inputs 的手动事件、定时及未知事件不使用该规则。
- 最小实现不新增上游来源 API 解析系统。保留已存在的 queue/running SLA、取消前二次读取、workflow 白名单和错误退出。
- 依据：[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)的运行上下文指向默认分支，实际源来自触发事件。当前只证明代码风险，未证明曾误取消。
- 收益：避免取消不同业务源。风险：部分重复排队任务改由既有并发组或超时策略处理。验证：相同上下文/不同上游、相同直接事件源、不同分支、非排队状态、取消前状态变化。
- 回滚观察：超龄 backlog 和合法运行取消记录。既有 CI 90 分钟、Field 150 分钟、发布 120 分钟 SLA 暂不调整；冷路径预算审查结果只作为后续调整依据。

### A3 / P1：限制官方构建依赖安装等待

- 修改 `build-official-codex-source.yml` 的 `Install official Linux build dependencies`，添加步骤级 `timeout-minutes: 10`，保留当前整体 job 上限。
- 10 分钟是本 PLAN 选择的安装预算，不是测得的分位数；依据是正常热路径约一分钟完成整个官方源码复用 job，而异常安装曾独占近 90 分钟。
- 不加宽泛重试、静默跳过或继续执行；超时必须失败并阻止下游验收。Rust、锁文件、runner 镜像和 Linux 输入仍参与指纹。
- 收益：异常外部安装尽早终止，保留失败步骤。风险：依赖源持续缓慢时出现较早失败。验证 YAML 契约及自然冷/热云端运行；回滚观察正常安装是否逼近上限，再按证据调整该单步预算。

### A4 / P1：移除同 job 重复 Wire 构建

- 在有显式 Wire build 的安装步骤设置 `SKIP_HAPPY_WIRE_BUILD=1`，复用现有 postinstall 开关；只作用于该安装步骤。
- 检查范围：`ci.yml`、`cli-smoke-test.yml`、`codex-android-field-e2e.yml`、`build-happy-agent-release.yml` 中匹配的安装/构建步骤。
- 逐个确认安装后的首个消费者之前恰好有一次显式 Wire build；没有显式构建的路径不设置该变量，不删除依赖补丁或笼统禁用 lifecycle scripts。
- 收益：确定减少重复编译，时长未量化。风险：安装生命周期提前消费 Wire。验证现有安装/构建顺序与自然云端检查，不在本地安装或打包。
- 回滚观察：Wire 产物缺失或安装阶段报错，按具体 job 撤回变量。跨 job 的 CLI/Wire 产物共享不纳入首轮。

### A5 / P1：减少无必要验证轮次并核对 PR 比较基准

- 默认由 PR 自然触发必要检查；手动全量仅用于自然入口无法提供的必要验证，不在同一 SHA 成功后惯例再跑一次。
- PR 的影响范围统一为 merge-base 到 head，push 仍为 before 到 head；实际被测试对象继续是 PR 合并结果。更新主 CI/Smoke 共用分类器、CodeQL 分类器和调用方的事件输入，保留缺失有效对象时失败退出。
- 收益：落后 main 的文档 PR 不因 main 独有源码变化误跑全套；减少额外手动轮次。风险：差异范围与集成验证混淆，因此 strict 门禁、PR 合并结果测试和 main CI 均保留。
- 验证分叉分支、main 独有改动、合并后改动、revert、删除/改名及 push 比较，确认混合修改仍取必要集合。
- 回滚观察：PR 影响集合出现漏选时恢复旧比较模式，不更改 required checks；不宣称整个手动 run 成本均可节省。

## 后续取证与进入条件

### B1 / P1：Field 连续失败归因

最近十次定时 Field（2026-08-29 至 09-07）均失败，Happy 源 SHA 相同；外部 latest Codex、镜像和缓存可能不同。
[最新场景 job](https://github.com/KNaiFen/happy/actions/runs/34165143962/job/101874926757)在 API 36 场景步骤失败，不能仅据此称为 flake。

实施时先只读选择最近失败、首个连续失败、之前一次真实完整成功的必要日志/结构化诊断，核对官方版本/commit、recipe、APK 指纹、阶段、实际失败断言和生命周期结果。
receipt 命中并跳过真实场景的两分钟成功不能作为完整成功对照。日志仅摘取固定阶段与断言，不传播请求或凭据载荷。

输出根因及最小修复文件范围。若属于 CI/夹具，在补齐具体修复和验证方案后纳入同一 PLAN；若涉及产品协议、生命周期或可分发行为，先明确受影响包、补丁版本和验收范围，再取得该新增范围授权。
不能以延长等待、停用 schedule、降低断言或固定旧 Codex 来伪造恢复。证据不足时 B1 保持未完成，不阻塞独立 A 项交付。

#### 已获批的兼容性修复

- 同一 Happy SHA 和 APK 指纹下，真实成功 run `33139290512` 使用 Codex 0.150.1；首败 `33276784340` 使用 0.151.0，最新失败 `34165143962` 使用 0.153.4。失败断言集中于 rollback 和清空后的后续输入，其他工具及生命周期检查完成。
- 官方 0.151.0 默认使用分页持久历史，并明确拒绝 `thread/rollback`；同版本将 `thread/revert` 纳入稳定 API。现场没有保留底层 RPC 原文，因此根因是由版本分界、官方源码及 Happy 调用链支持的高置信归因。
- 最小修复位于 CLI `codexAppServerClient.ts` 及协议类型入口：仅在支持稳定 revert 的版本明确拒绝分页 rollback 后，读取完整历史，按 turn 数定位首个应删除的 turn，调用 `thread/revert(beforeTurnId)`，然后重新获取完整权威快照。其他错误继续传播，最低支持版本仍为 0.147.0。
- 保留 0.147.0 生成协议原样；仅在手写协议入口补充有官方来源的稳定兼容 RPC 类型，避免为一个方法升级全部生成协议及消费者。Wire/App 的命令契约不变。
- 覆盖全部清空、部分回退、超出历史长度、空历史及清空后继续输入；复用已有 fork/executor 验证。云端使用 latest 官方源码和完整 Android Field，不以夹具单独通过代替真实验收。
- 仅 CLI 由 1.4.54 升至 1.4.55；若该版本已运行发布，则按项目规则使用下一个补丁号。成功后下载并验证正式 npm 归档，再按本机更新规则安装。

#### 当前验证

- A 项分类器、provider 边界及 watchdog 共 36 项测试通过；官方产物与工作流固定引用契约另 18 项通过。
- CLI client/executor/fork/trace 共 98 项测试及 CLI `tsc --noEmit` 通过。官方场景类型检查在 TS API 中将根目录缺失的 `vitest`/`tweetnacl` 解析指向 CLI 已安装依赖后通过，未修改依赖或项目配置。
- `actionlint -shellcheck=` 通过。默认 ShellCheck 报告的 SC2155/SC2129 均来自未修改的脚本行，保留为既有提示。
- CI 独立审查发现的 fork/PR 来源身份问题已修正；兼容修复独立审查无必要 findings。已做消融审查，复用既有 diff 与协议入口，没有新增通用分类或兼容框架。
- 真实 latest 官方 app-server、最终 PR/main、完整 Android Field 和 CLI 正式制品尚待云端验证；以上源码证据不代表交付完成。

#### 首轮云端失败后的必要修复

- PR #73 / `f77297a7` 的 CI `34247558247` attempt 1 编译了官方 0.153.4。官方场景在新增 rollback 断言之前缺少命令事件；已定位 Responses fixture 固定请求旧 `shell_command`，而新版提供 `exec_command`。修复为选择实际提供的工具及 namespace，使用对应参数并检查真实工具输出 sentinel；首个 observer 工具响应等待订阅完成，完整历史读取复用既有分页兼容入口。
- Gateway 首轮错误仅有 `rootBinding:runtimeProjection:protocol`，尚无底层根因。最小诊断补丁仅保留稳定 RPC 方法和数值错误码，不记录 provider 错误原文或业务载荷，不凭猜测修改生命周期。
- 同一 CI 的依赖门禁要求 `browserslist 4.28.7`、`fast-uri 3.1.6`、Tauri `h2 0.4.16`。只更新既有 override 与锁文件，不调整门禁/例外、不深入漏洞机制；pnpm lockfile-only 和 cargo update 均不编译。Node 依赖门禁已通过，仍为原有三项临时例外。
- `fast-uri` 进入 CLI 和 Relay 运行时，因此必要补丁扩展到 Relay `1.1.47`；CLI 保持尚未运行发行的 `1.4.55`。App 的变化仅为构建工具/非正式发行的桌面锁文件，不触发 Android 发行。正式 Relay 成功后沿项目规则验证并部署精确制品。
- 修复验证：Responses fixture 12 项、CLI client 60 项、Gateway worker 28 项测试通过，CLI 与官方 fixture 类型检查通过。未在本地编译发布制品。最终 PR/main/Field 结果仍待新提交验证。

#### 2026-09-09 验收接续

- `aa0ddbc0` 对应 run `34263797073` attempt 1 的包检查、依赖门禁、Smoke、文档及 CodeQL 通过；官方 app-server 与 Gateway 失败，未重复开展优化调查。
- Gateway 的明确错误为临时线程拒绝 `thread/goal/get`。仅对方法、错误码 `-32600` 及包含当前 thread ID 的完整官方错误匹配，返回空 goal，使线程同步继续；其他读取错误及所有 set/clear 错误仍传播。补丁仍在未发行的 CLI `1.4.55` 内。
- observer 的短命 shell 输出可能在官方 streaming watcher 订阅前产生，因此保留标准输入握手和真实 delta 断言。当前工具启动失败的具体原因未证实；失败报告增加有限输出形状类别和权威 turn status，禁止输出原始载荷。
- 本地 client/router/migration/Gateway 六文件 179 项测试、Responses fixture 12 项测试、CLI 类型检查及官方场景类型检查通过。官方场景沿用既有 TS API 依赖路径映射处理本机根目录缺少 `vitest`/`tweetnacl`，未修改安装状态。云端验收待后续提交。
- `44710051` / run `34270694923` 的安全分类确认 shell 在沙盒创建进程阶段失败；`cfcc0819` 改用临时文件释放输出，避免 PTY 依赖，同时保留真实 delta。run `34272052380` attempt 1 的官方 app-server 完整生命周期已通过，Gateway 仍在 App 回合与 attach 失败。
- 官方 0.153.4 TUI 的自动标题功能发送 `thread/start(ephemeral=true, threadSource="system")`；Proxy 将它误当用户根并替换 current。最小修复透明转发系统线程但不预留/绑定为根，保留普通用户 ephemeral 行为；夹具按 descriptor.current.sessionId 选择 App 会话，并核对 thread/generation。代理、worker、coordinator/router 共 127 项测试、CLI 与 TUI 类型检查通过，真实 Gateway 云验收待下一提交。
- `71aea20c` / run `34274184130` 的终端/App、11 分钟存活和异常断开通过，正常退出后的 Gateway/provider 也已停止；唯一失败为夹具失去 current 后使用旧 session.active。`fd9286b3` 修正为按原会话身份查询 Relay 最新状态。
- `fd9286b3` / run `34276234102` attempt 1 的所有主 CI jobs 通过，包括官方 app-server、完整 Gateway PTY/attach/正常停止；Smoke、文档、Required CodeQL 通过。最终独立增量审查未发现必要 findings。自动评论指出本地测试执行 HTTP 回传命令文本，故移除这段冗余辅助执行；真实官方云端验证和协议断言保留。
- 本文件的实施记录已完成并随同一 PR 归档；归档不声称尚未产生的最终 PR/main/Field、制品或部署结果成功。剩余交付由既有授权继续执行并记录于本机记忆，B2 候选未实施。

### B2 / P2：矩阵、下载与缓存维护

以下是有证据的候选，不是本次批准首轮即可实施的扩展：

| 候选与位置 | 进入实施前提 | 收益、风险、验证与回滚 |
| --- | --- | --- |
| `codeql.yml` 与 `codeql-change-classifier.cjs` 按语言选择增量矩阵 | 建立语言、生成器、锁文件、workflow 输入映射；周扫描仍全量 | 减少无关语言 job；跨语言输入可能漏选；验证删除/混合/未知输入与聚合失败传播，漏选时恢复四语言 |
| `android-field-apk-reuse.cjs` 消除选择与消费双下载 | 明确临时文件所有权和同 job 可复用边界，消费端继续校验 digest、布局、来源 | 减少传输；临时路径丢失可能破坏命中；验证命中、过期、损坏及未命中，必要时恢复原路径 |
| 官方源码热路径准备、APK 指纹范围及已压缩产物上传 | 取得可比步骤成本与真实输入依赖；保持 recipe 和来源校验 | 缩短准备/上传或避免无关失效；漏输入风险；用自然命中/未命中样本核对，异常时恢复原 recipe/上传配置 |

不新增通用分类平台、缓存服务或跨 workflow CLI 构建制品系统；不为优化效果单独发起固定演练矩阵。
当前缓存体积不构成清理授权，不清理本机依赖、SDK、缓存或云端制品。

## 验证与交付顺序

1. 实施前读取目标目录规则，重新确认 main、规则集、工作树和相关源差异；选择一个 origin 功能分支承载首轮修改及本 PLAN。
2. 先完成 A1/A2，再完成 A3/A4/A5；B1 只读取证可与独立工作分开安排，依赖其根因的修改必须后置。
3. 本地只运行受影响的现有 Node 契约测试：`classify-workflow-changes.test.cjs`、`codeql-change-classifier.test.cjs`、`assert-codex-only-provider.test.cjs`、`actions-sla-watchdog.test.cjs`；若触及 APK 复用才运行其对应测试。只补覆盖真实门禁/取消/跨模块输入风险的用例，不新增镜像实现的零碎测试。
4. 检查 YAML、外部 Action 固定引用、聚合失败传播、安装顺序，运行 `git diff --check`；涉及文档先暂存目标内容，再 `pnpm docs:sync`、暂存生成文件、`pnpm docs:check`。
5. 做消融审查：删除不必要抽象、重复输入清单、推测性回退和额外构建步骤，确认没有减少真实协议/发布验收。
6. 每个完成的逻辑任务用中文提交；多次本地提交不等于多个 PR。PR 最终 head 必须通过四项现有门禁；修改公共 CI 分类可能自然触发广泛云验证，属于必要实现验证。
7. 合并前整理已经完成的首轮内容，准确标注已有本地/PR 证据及尚待产生的最终 head/main 结果；整理提交仍须通过最终 PR 门禁。若 B1 仍未完成，保留具体下一步，不能把整个 PLAN 标为完成。已知整理纳入当前 PR，合并后结果写本地记忆。
8. 获准合并后核对精确 main SHA 的必要 CI；版本无变化时发布 router 必须跳过产品构建。主 CI 变化命中 Field 范围时读取自然运行，不另开生产发行或手动效果演练。
9. 远端等待绑定确切 run/head，必要长时监控沿用 `gkd-ci-monitor`、总预算 6 小时。超时或外部失败如实保留，不把取消或重跑等同成功。
10. 归档条件是首轮验收完成，且 B1 有可核验结论或已明确转交独立计划；B2 未获准候选不作为首轮无限延长的验收门槛。全部工作完成后归档本 PLAN 并同步索引。

首轮 A 项无包版本变化；追加 B1 和云端必要依赖补丁交付 CLI 1.4.55 与 Relay 1.1.47。分别按既有规则完成本机 CLI 安装、精确 Relay 制品验证与部署。
如需要回滚，按具体提交/变更点创建正常 revert，经同一门禁交付，不强推、不重用已发行版本、不删除 required checks。

## 成本对照与效果记录

墙钟为 `updated_at-created_at` 的终态近似；累计时间为非 skipped job 的 started-to-completed 之和，不是计费分钟。
重跑 API 可能重列上次成功 job，不能把各 attempt 全表相加；`created -> run_started` 也不等于 runner 排队时间。

| 自然样本 | 墙钟 | 累计 job 时间 | 解释 |
| --- | --- | --- | --- |
| [#71 PR CI](https://github.com/KNaiFen/happy/actions/runs/32083061338) | 14分36秒 | 28分40秒 | 官方源码复用 61 秒；Gateway 场景 708 秒 |
| [#71 main CI](https://github.com/KNaiFen/happy/actions/runs/32084079742) | 14分41秒 | 29分06秒 | 同树再次集成验证，并绑定可信 main 来源 |
| [#70 PR CI](https://github.com/KNaiFen/happy/actions/runs/32011576640) | 55分31秒 | 78分56秒 | 官方构建 job 2484 秒，之后 Gateway 787 秒 |
| [#71 发布 router](https://github.com/KNaiFen/happy/actions/runs/32085037801) | 23分30秒 | 24分48秒 | Android 与 CLI 并行；不能把两者墙钟相加 |
| [异常安装](https://github.com/KNaiFen/happy/actions/runs/32084297782/job/95553551297) | 安装步骤 89分55秒 | 不作为正常构建基线 | 未进入官方源码编译，最终取消 |
| [#61 归档 PR CI](https://github.com/KNaiFen/happy/actions/runs/31794589353) | 26秒 | 未单独汇总 | 重型 job 均跳过，归档 merge 没有 main push CI |

#71 是一个 PR、两次代码提交、三次分支 CI run/四个 attempt，再加一次 main CI；PR 创建到发布完成共 53分40秒。
manual 是全量，PR/main 是影响选择范围，不能承诺省掉全部 manual 成本。#67 的 13 个提交最终仅触发一次 PR CI。
#60 实现与 #61 单独归档的时间重叠，后者只增加一次轻量 PR/合并；后续 `workflow_run` 顶层出现归档 SHA，不能据此断言归档触发重型 Field。

后续优先复用自然运行，记录同类变更、源树、事件/attempt、官方 recipe、runner 镜像、缓存/制品命中、首次有效反馈、墙钟、累计 job 时间和重复轮次。
只在可比输入下评价步骤变化；无可比样本时报告“实现已验证，效果待观察”，不编造百分比、P50/P90 或 flake 趋势。
