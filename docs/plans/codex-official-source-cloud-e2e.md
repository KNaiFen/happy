# Codex 官方源码云端 E2E 计划

## 目标

把需要构建产物的验证全部迁移到 GitHub Actions。本地验证只运行源码、`tsc --noEmit`、直接 Vitest/tsx 脚本或开发服务器，不生成 CLI、Web、Android、Rust、Docker 或发布产物。

修正两条名不副实的测试边界：

- Android field E2E 不再用 Happy 自制的 fake app-server 冒充 Codex，而是在云端从 OpenAI 官方 Codex 仓库构建真实 `codex app-server`。
- 原“真实十分钟 turn”不再用 fake app-server 空等十分钟；替换为短时官方 app-server 生命周期场景。长期 active 不得被时间驱动地结束，由虚拟时钟和状态机单元测试覆盖。

## 固定边界

- Happy 运行时最低支持 `codex-cli 0.145.0`，类型生成继续固定 non-experimental stable-v2 `0.145.0`，用于最低兼容与协议漂移门禁。
- 官方端到端场景在每次云端运行时解析 OpenAI Codex 的最新稳定 GitHub Release，拒绝 draft、prerelease 和非 `rust-vX.Y.Z` tag。
- Release tag 必须解析到不可变 commit；工作流记录 tag、版本、commit，并从该 commit 构建。当前确认的稳定发布是 `rust-v0.146.0`，peeled commit 为 `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`。
- 不启用 experimental app-server 协议。
- 不需要 OpenAI 凭据。仅模型提供方使用本地 Responses API SSE 模拟器；app-server、JSON-RPC、thread/turn/item 生命周期和 Happy CLI 映射全部运行官方实现。
- 自制 fake app-server 仅保留给重复、乱序、断线、未知方法、崩溃和恢复等确定性故障注入，测试名称必须明确标注 fake-provider，不得称为真实 Codex E2E。

## 云端构建

1. 新增可复用的官方 Codex 源码构建 job：
   - 通过 GitHub API 解析最新稳定 Release。
   - 校验版本不低于 `0.145.0`，解析 annotated tag 到 commit。
   - checkout `openai/codex` 的精确 commit。
   - 从源码的 Rust toolchain 文件读取 toolchain，并使用 Cargo cache。官方 Release 的 Cargo 构建不带 `--locked`，且当前稳定标签的锁文件在 Linux 上需要补充解析；因此先按官方语义运行依赖解析，校验工作树只能改动 `codex-rs/Cargo.lock`，记录源码锁与解析后锁的 SHA-256，再以解析后的锁执行 `cargo build --locked`。
   - target cache 以 bundle schema、不可变源码 commit 和解析后锁为键。命中时必须校验 runtime marker、二进制精确版本和 bundled bwrap 摘要，校验通过才跳过 Cargo；缺失、损坏或版本不符时从缓存依赖增量重建。首轮 run `30636131220` 冷编译耗时 40 分 12 秒且已成功保存基础 target。
   - 按官方 Linux primary bundle 顺序先构建并 strip `bwrap`，将其 SHA-256 通过 `CODEX_BWRAP_SHA256` 编入后续 `codex` 构建，再构建并 strip `codex` 与 `codex-code-mode-host`。产物保持官方相对布局 `codex`、`codex-code-mode-host`、`codex-resources/bwrap`；单独一个 `codex` 不构成可执行只读 sandbox 的真实 release runtime。
   - 校验 `codex --version` 与解析出的 Release 一致。
   - 上传二进制和不含敏感信息的来源元数据，供同一 workflow 的测试 job 下载。
2. monorepo CI 和 Android field E2E 各自在云端消费该构建产物；本地不构建官方 Codex。GitHub hosted Ubuntu 默认由 AppArmor 禁止非特权 user namespace，直接运行官方 bwrap 会以 `Operation not permitted` 退出；两个消费 job 必须复用官方 Codex Linux CI 的准备步骤，启用 `kernel.unprivileged_userns_clone`，并在内核暴露对应开关时关闭 `kernel.apparmor_restrict_unprivileged_userns`，然后继续使用默认 bubblewrap 路径，不得改用 deprecated Landlock 来制造假通过。
3. `0.145.0` stable-v2 类型漂移 job 继续安装官方已发布包并只验证最低协议基线。

## 模型协议模拟器

新增可复用的 loopback Responses API fixture：

- 使用与官方 Codex app-server 测试相同的 Responses SSE 事件形状。
- 生成独立 `CODEX_HOME/config.toml`，配置 `requires_openai_auth = false`、`wire_api = "responses"`、`supports_websockets = false`、零自动重试、只读 sandbox 和 `approval_policy = "never"`。
- 接收真实官方 Codex 发出的 `/v1/responses` 请求，记录请求次数、时序和 payload shape，不记录 prompt 明文。
- 能返回流式 assistant delta、reasoning summary、shell 工具调用和完成事件；短场景验证边界会立即经过 Happy CLI。
- 支持短暂连接抖动和受控失败，但不得取代 Sync v4 自身的 transport chaos fixture。

## 场景

### 官方 app-server 短生命周期门禁

- 启动源码构建的官方 `codex app-server`。
- 启动模拟 Responses provider，发送真实 `turn/start`。
- 在短时间内验证 thread/turn/item started、流式文本、阶段切换、最终文本和 `turn/completed`。
- 同时等待 Happy 命令结算与独立观察到的官方 `turn/completed`。官方 `0.146.0` 会先发送权威 `thread/status/changed: idle`、再发送 `turn/completed`，因此不得在前者结算命令后立即断言后者已经进入通知 handler。
- 验证 Happy 不因普通传输状态变化把 active 误判为 idle。
- 长时间无事件的语义用虚拟时钟覆盖，不占用十分钟真实 runner 时间。

### Android 全链路门禁

链路必须为：

`Android App -> Happy relay -> Happy CLI daemon -> 官方 codex app-server -> Responses fixture -> 官方 app-server -> CLI -> Sync v4 -> App`

验收内容：

- 零机器启动页能发现新注册 Codex 机器并创建会话。
- App 发出的消息成为 durable v4 command，官方 app-server 收到 turn，fixture 至少收到一个 Responses 请求。
- App 显示官方链路返回的唯一 sentinel 回复，刷新后仍存在且不重复。
- 日志和 artifact 记录 Codex tag/commit、provider 请求计数和各 v4 entity 数量，不记录 prompt、token、key 或模型输出正文。

### 确定性故障注入

继续使用 fake-provider 覆盖：

- 重复、乱序、丢 invalidation、polling 恢复、410 snapshot、进程退出和重启。
- 并行父/子线程、审批、unknown method、10,000 entity projection 和流式 p95。
- 名称与报告明确这是协议/传输故障注入，不作为官方 Codex 兼容证据。

## 本地验证规则

允许：

- `tsc --noEmit`
- `HAPPY_SKIP_CLI_TEST_BUILD=1` 下直接运行相关 Vitest 源码测试
- `tsx` 直接运行 fixture/self-check
- `npm run dev`/`pnpm ... dev` 和其他不生成分发构建物的开发服务器
- YAML/JSON/脚本静态解析、`git diff --check`

禁止：

- `pnpm build`、会隐式调用 build 的 package `test` 脚本
- Cargo/Tauri/Gradle/Expo export 或 prebuild
- Docker build、npm pack、发布归档和任何 release artifact 构建
- 本地构建 OpenAI Codex 源码

所有禁止项由云端 workflow 执行并作为 required gate。

## 验收与发布

- 计划、workflow、fixture 和测试脚本通过源码级静态检查后提交并推送到 `origin`。
- 等待 monorepo CI 与 Android field E2E；根据真实云端构建和运行错误继续修复、提交、推送，直到 required gate 全绿。
- 本轮只改 CI、测试 fixture 和文档，不改变分发运行时代码时不推进 CLI/App/Server/Wire 版本；若云端暴露必须修改的分发代码，再按受影响包推进 patch 版本。

## 执行状态

- [x] 固化本地源码级验证规则，并保留 `0.145.0` stable-v2 最低兼容门禁。
- [x] 新增最新稳定 Release 到不可变 commit 的解析、官方源码 Cargo 构建、`rusty_v8` 校验和 provenance artifact。
- [x] 新增无凭据 Responses SSE fixture、shell 工具 follow-up、reasoning summary、分块回复及源码自测。
- [x] 用独立的官方 app-server 短生命周期门禁替换 fake 十分钟等待；两小时无假结束继续由虚拟时钟单测覆盖。
- [x] Android field fixture 改为官方 app-server 全链路，并补充 provider/tool/provenance 诊断。
- [x] 提交并推送分支；首次云端运行确认官方标签源码、Rust toolchain、Linux 依赖与 `rusty_v8` 均可取得，并暴露标签锁文件无法直接使用 `--locked` 的真实构建差异。
- [x] 采用“官方解析语义 + 双锁文件指纹 + 解析后 locked 编译”修复云端源码构建；run `30636131220` 从官方 `0.146.0` 标签成功产出并校验二进制。
- [x] 修复首次真实生命周期运行暴露的 `thread/status/changed: idle` 与稍后 `turn/completed` 之间的测试竞态；门禁现在独立等待两条边界并保留有界、无明文的方法顺序诊断。
- [x] 让精确 target cache 命中时复用已校验的源码构建二进制，避免每条工作流重复执行 40 分钟冷编译。
- [x] 修复 run `30640510094` 暴露的单文件伪 bundle：补齐官方 bundled bwrap/摘要和 code-mode host，并要求真实 shell command 的流式与最终输出、退出码全部成功。
- [x] 修复 run `30642025606` 暴露的 hosted runner user namespace 限制：按官方 Codex CI 配置 AppArmor/sysctl，使完整 bundle 的默认 bubblewrap 沙箱实际执行命令，不降级到 deprecated Landlock。
- [ ] monorepo required gate 与手动 Android field E2E 全绿后归档本计划。
