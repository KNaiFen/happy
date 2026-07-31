# Codex Sync v4 R8 本地设备接入修复归档

## 状态

- 实施日期：2026-07-30
- 本地状态：完成
- 目标版本：CLI `1.4.6`、Server `1.1.23`
- 保持版本：App `1.11.11`、Wire `0.1.3`
- 后续完成记录：`docs/plans/archive/codex-sync-v4-remediation-r12.md`

本文件保存 R8 已完成的根因、实现和本地验证。云端发布与物理设备验收完成前，
R8 整体仍未关闭。

## 根因

Debian relay `1.1.22` 的最终 production tree 组合为：

- PGlite `0.3.16`
- Prisma / Prisma Client `6.19.2`
- `pglite-prisma-adapter 0.7.2`
- Prisma driver adapter utils `7.2.0`

adapter `0.7.2` 只声明支持 Prisma 7。该组合会把非空 Prisma `Bytes` 返回成数字
键对象，使 Machine/Session 创建虽然已经提交，响应和后续列表却触发 `P2023`。
因此 App 的认证与 Socket 正常，但 `/v1/machines` 和 `/v1/sessions` 返回 500，
App 停留在添加设备页。

CLI 随后进入离线路径，旧 session stub 又缺少 `onFileEvent`，导致
`session.onFileEvent is not a function`。同一轮审查还确认：

- daemon 只按 CLI 版本识别实例，不区分 relay origin；
- 旧 credential 不绑定 relay，切换服务后会携带错误 token；
- Machine 5xx 会生成假 Machine 并错误开放 RPC；
- offline stub 不迁移回调、RPC、outbound 或 EventEmitter 监听器；
- 100,000 条离线 FIFO 使用 `Array.shift()` 会形成 O(n²) 恢复；
- 新通用离线队列会在 Codex v4 session 恢复前重放 legacy v3 输出；
- 普通 Fastify 5xx 会重复记录 Prisma message、stack、URL、IP、User-Agent 和
  加密字段字节。

## Server 修复

- 精确锁定 PGlite `0.3.15`、adapter `0.6.1` 和 Prisma `6.19.2`。
- 用 dev-only alias 保留 `0.3.16` / adapter `0.7.2`，只用于构造精确旧卷。
- production verifier 同时校验 source、deployed manifest、实际安装版本、
  adapter peer、driver utils major，且阻止测试 alias 泄漏进镜像。
- `/health` 执行合成 `BYTEA` 解码并逐字节校验，错误返回固定 503。
- 普通 Fastify 错误只记录一次固定终态分类、状态、路由模板和受限错误码；
  5xx 响应不包含内部 message/stack。
- 恢复原有 Sync v4 和 404 脱敏测试，并新增 Prisma payload-free 500 门禁。
- 覆盖 Machine、Session、Artifact、GitHub token、service token 和 KV 等
  Prisma `Bytes` 字段的写入、重开与逐字节读回。
- 精确旧 runtime 写入会复现 `P2023`；新 runtime 能原地打开相同目录并读取
  完全一致的账户、Machine、Session、ID 与密钥，不需要 migration、清库或
  重建 master secret。

## CLI 修复

- `ApiSessionClientContract` 提供编译期完整公开契约，真实 client 明确
  `isOffline=false` 并公开只读 agent state。
- offline facade 完整实现文件、用户消息、附件、metadata、agent state、
  RPC、EventEmitter、flush 和 close 表面。
- attach 迁移 user/file 回调、附件、RPC handler、`on`/`once` 监听器和 FIFO
  outbound；provider binding 成功后才提交 session swap，失败可 detach 重试。
- FIFO 使用游标推进和分段压缩，避免逐项 `shift()`；部分重放失败时保留首个
  失败项及尾部，10,000 条顺序恢复测试通过。
- facade attach 后的 void 发送会安全吸收后台 drain 拒绝，保留失败 FIFO 头；
  显式 `flush()` 或重新 attach 可以重试，不触发进程级未处理拒绝。
- Codex 已确认 v4 且 session 离线时抑制 legacy v3 provider 输出，恢复以后
  官方 thread snapshot 与 v4 entity 为权威来源。
- relay URL 统一规范化为 HTTP(S) origin，拒绝 credential、path、query 和
  fragment。
- credential 记录规范化 `serverOrigin`；legacy credential 验证成功后原子
  绑定，origin 不符或 401/403 提示 `happy auth login --force`。
- credential 文件使用随机独占临时文件、0600 权限和原子 rename。
- daemon state 同时记录 CLI 版本、relay origin 和 Machine
  `pending | registered`。
- 相同版本但不同 relay 的 daemon 会被协调停止；父 CLI 已验证绑定的凭据允许
  daemon child 跳过重复 10 秒探针。
- Machine 网络错误、404、5xx 返回 `null`，不再生成假已注册对象；daemon
  先开放本地控制面，再以 1/2/4/8/15 秒重试真实注册，只有权威响应后才开放
  Machine RPC。
- `happy daemon start` 只在 Machine 权威注册后显示成功，否则明确显示 pending。

## 发行场景增强

- Debian bundle 生命周期使用真实签名认证创建非空 Machine/Session。
- 创建响应、列表、容器重启后的列表均逐字节核对 data encryption key。
- Codex HTTP 场景新增 Machine 创建、列表和 relay 重启后的持久性检查。
- 保持 Web HTTPS/localhost only；原生 CLI/App 的 HTTP 仍只允许可信网络显式
  启用，主动 MITM 下不承诺 token、ACK、服务身份、metadata 或零丢失。

## 本地验证

- 冻结 lockfile 安装：通过。
- CLI build、typecheck、全量 unit suite：通过。
- Server typecheck：通过。
- Server unit suite：`17` 文件、`116/116`，含 100,000 mutation chaos。
- PGlite：38 个 migration、全部 Bytes round-trip、精确旧 runtime 卷升级通过。
- App：先前完整 suite `81` 文件、`915/915`，本轮无 App 代码变化。
- Wire：先前 `38/38`；Agent：先前 `227/227`，本轮无对应代码变化。
- 真实 Codex -> CLI -> HTTP relay -> App：
  WebSocket、polling、Server restart、snapshot 410、审批、child、trace、privacy、
  10,000+ entity、20 个 delta 全通过，p95 `236.4 ms`。
- workflow YAML、Shell 语法、`git diff --check`：通过。
- production audit：176 个既有问题，`73 high`、`0 critical`。
- production deploy tree 已确认只包含稳定 runtime 版本，不包含测试 alias。
- 本地未运行 Bun Server runtime build、Docker bundle lifecycle 或 Cargo/Tauri；
  按项目约束交给 GitHub Actions。

## 转入活动计划

- 提交并推送当前分支。
- 修复 GitHub Actions 直到 required gate 全绿。
- 正常同步到 `origin/main`。
- 验证 CLI `1.4.6` 和 relay `1.1.23` release。
- 下载、校验产物并完成原卷升级与物理设备验收。
