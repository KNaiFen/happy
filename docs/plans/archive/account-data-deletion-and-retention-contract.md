# 账户数据删除与保留契约实施计划

## 状态

- 当前状态：已完成并归档。
- 完成日期：2026-08-14。
- 实现与合并基线：PR [#57](https://github.com/KNaiFen/happy/pull/57) 已合并为
  `ec111f88f25137daa94345500a500a3738c0977c`。同 SHA 的
  [Happy monorepo CI](https://github.com/KNaiFen/happy/actions/runs/31771237499)、
  [release](https://github.com/KNaiFen/happy/actions/runs/31772002158) 与
  [Codex Android Field](https://github.com/KNaiFen/happy/actions/runs/31772002188) 均成功。
- 发行证据：release 提升 App `1.11.48` ARM64 artifact `9208879292` 与 Server/Relay
  `1.1.44` artifact `9208743406`；候选物和提升物均绑定该精确 source SHA。
- 直接验收声明：维护者于 2026-08-14 确认本计划所列的实机、直接证明和托管运维操作均已测试且无问题，
  包括旧 S3 直传签发器排空、`ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT` 的实际记录、三天
  备份/运维日志保留，以及一次真实删除后的对象、日志和备份检查。精确配置版本、时间戳和受控运维记录
  不复制到公开仓库。
- 负责模块：Happy App、happy-server 与隐私文档维护者。
- 建立日期：2026-08-10。
- 契约确认日期：2026-08-12。
- 已确认范围：删除全部 Happy 账户数据；不提供导出；不提供撤回期或恢复入口。
- 托管服务：主数据和对象进入删除流程后立即禁用访问；备份与运维日志的最长保留期为三天。
- 自托管：部署者是其数据库、对象存储、备份、容器日志和外部服务配置的责任方；本项目提供
  主数据删除路径与配置说明，但不能替部署者删除其基础设施副本。
- 本地实现证据：新增 `Account.deletionRequestedAt`、删除 challenge/request/upload-operation 迁移、账户
  API、持久删除 worker、认证/Socket 写入门槛、受控附件/头像代理，以及 App 设置确认和本地登出。
  S3 升级使用 `ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT` 作为最终 sweep 栅栏，删除器只在
  旧 capability 和删除前获准上传取得确认成功后扫描对象；上传操作没有按时间自动释放，避免慢速或
  结果未知的 S3 写入在最终 sweep 后落盘。S3 sweep 枚举并删除对象的所有版本与 delete marker；最终数据库事务
  先锁定 Account、清理未再关联 Account 的历史 GitHub OAuth 记录，并清空历史跨账户头像路径引用。
  历史 orphan 附件使用全局、持久、限流 GC，不在每个账户重试中扫描整个 bucket。上传操作记录对象 key
  和确认完成时间；确认完成后即使 bookkeeping row 的最佳努力清理失败，也不会阻止删除。附件 PUT 本身
  限制为 10 MiB、每个进程每账户每分钟 60 次；S3 版本删除以最多 1000 条串行批处理，避免按账户对象数
  无界积累内存。
- 当前本地验证证据：App 全量源码 Vitest 123 个文件/1132 项通过；Server 全量源码 Vitest 51 个文件/
  315 项通过，PostgreSQL 专用 3 项按开关跳过；终审修复的 App Artifact fence 9 项与 Server Artifact
  create/REST/Socket 18 项通过；PGlite 的 3 项验证通过并从空库明确执行全部 44 个迁移。
  App、Server `tsc --noEmit`、Prisma validate、知识库检查、`git diff --check` 与
  `git diff --cached --check` 均通过。本机没有可执行 PostgreSQL；真实 PostgreSQL 双 client 竞态与 migration runner 由 migration CI 作为合并
  硬门禁，不能以本地 PGlite 结果替代。
- 当前准入边界：Voice 已使用持久 admission；提供者 mint 成功且响应送出时，删除器会等待已签发 token 的
  签名 `exp`，而非仅等待 HTTP 请求结束。GitHub OAuth 在同一 Serializable 事务中取得账户写入准入、
  生成绑定 admission 的 state 并持久化 admission，只有事务成功后才返回 state；callback 原子 claim 后
  才交换 code、读取 profile 和连接账户。删除器等待所有已 claim callback 明确结算；token POST 的传输或
  解析结果未知时不按 state TTL 自动释放。附件 URL/下载、Push、Presence flush、Socket RPC 和
  账户读取均在 Serializable 事务中取得账户行准入；外部动作在删除前取得准入后可完成，删除标记后不再建立新的准入。
- 不可撤销边界：删除标记前已经准入的附件下载流可继续发送已打开的流；已经交给 Expo 的通知、已发往远端
  provider 的 RPC 或第三方处理不能与数据库删除原子撤回。删除确认会断开连接并阻止新的准入，但不声称撤回
  已发送字节或第三方已经接收的副作用。
- 已关闭事项：对应 PR、main CI、发行候选/提升和 Field 验证均已完成。托管运维验收由维护者的
  2026-08-14 直接声明关闭；仓库仍不替代或公开托管基础设施的配置版本、时间戳和删除记录。

## 背景与证据

建立本计划时，App 只能删除单个 session 和已注册的 push token；session 附件清理是非致命的，
普通账户 token 也不会在缓存命中时核验账户状态。这些是实施前的历史事实，而不是当前规范。

当前实现用持久删除请求替代旧的 best-effort 路径。已确认删除先锁定账户；删除器在旧 capability
排空且每一个删除前获准上传已取得确认成功后，才清理所有已知对象前缀。对象操作没有 TTL：未知的
S3 写入会让删除保持 pending，而不是将超时或失败回调误认为取消。清理会枚举所有 S3 object version 和 delete
marker，逐项失败或剩余版本都会继续锁定并重试。最终事务锁定 Account 行后读取关联数据，避免并发
GitHub 连接留下 OAuth token/profile；params 创建与 callback claim 的持久 admission 让删除 marker 与
新的 OAuth 准入竞争同一账户锁，删除器随后等待已 claim callback 的持久结算。token POST 的传输或解析
结果未知时 callback 会保持未结算和 pending，不会因 state TTL 到期而被当成完成。
未被任何 Account 引用的历史 GitHub 记录会被回收，旧版跨账户
头像路径会从其他账户 profile 中清除。当前附件和头像都经 Server 代理，避免新请求取得不可撤销的
S3 URL；历史 orphan 附件需要全局 GC 才能识别，因旧的 session 删除已移除其账户归属。托管备份和
日志保留仍是运维事实，不能由代码或本文档自行证明。

## 目标

提供不可撤回的账户级删除：确认后立即拒绝该账户的新认证、读取和写入准入并断开实时连接，再可靠清理账户关联的关系数据、
会话密文、Sync v4 journal、附件、头像、认证材料、设备、push token、集成 token、Artifact、
社交/Feed/KV 和语音用量记录。删除进度在主数据清除完成前持久化，以便对象存储失败后重试；
完成后不保留账户、删除挑战或清理记录。删除标记前已进入处理器的普通数据库写入可能先完成；最终
删除事务会重新读取并清除这些主数据，它们不能重新开放或恢复账户。附件、头像、GitHub、presence 等
会产生外部或长期状态的路径另有最终数据库删除标记门槛。删除标记后不再准入新的附件流、Push 外发或
RPC 派发；删除标记前已经准入的流或第三方请求可能完成，不能被误写成可跨系统回滚。

## 实施步骤

1. [x] 新增短时、服务端生成、单次消费且绑定账户的删除挑战。仅账户凭据可以创建和确认；terminal/
   machine credential、错账户公钥、过期 proof 与重放一律拒绝。客户端使用账户 secret 派生的签名
   key 对服务端挑战签名，服务端不记录 secret、签名或未加密 payload。
2. [x] 确认删除时原子消费挑战并标记账户为不可访问，撤销本进程 token cache、断开所有用户 scope
   Socket.IO 连接、清除活动缓存。认证路径必须在缓存命中与未命中时都验证账户仍存在且未进入删除。
3. [x] 持久化删除请求并由服务端立即处理、启动恢复和定时重试。旧 S3 直传升级必须先记录所有旧
   签发器已排空的 UTC 时间，最终物理 sweep 至少在该时间 16 分钟后执行；代理上传和头像写入会创建
   无自动过期的持久上传操作，并记录对象 key；只有对象写入确认成功并持久化完成时间后才会结束；
   任何失败或未知结果都会保持 pending。附件代理在解析层限制单次 10 MiB，并对实际 PUT 限流。
   只有栅栏和所有上传操作均已
   结束时，才按当前 session 附件前缀和 `public/users/<accountId>/` 流式枚举、每 1000 条串行删除并复查所有对象版本和
   delete marker。对象逐项失败、栅栏未确认、上传状态未知或清理未完成都不会重新开放账户，也不报告
   为已完成。
4. [x] 在一个可重试事务中先锁定已标记 Account，再按外键顺序删除 AccessKey、SessionMessage、
   UsageReport、Session（含 v4 cascade）、Machine、两类 auth request、push token、上传文件、
   service token、Artifact、关系、Feed、KV、VoiceConversation 与 GitHub OAuth token/profile；
   随后删除 Account、清理请求和无 Account 引用的历史 GitHub 记录。
5. [x] App 在账户设置危险区提供明确的不可逆确认。proof 离开客户端前先同步隔离内存认证与 Sync，
   同步结束 token-bound outbound generation、停止全部 Sync 队列/v4/git sync、卸载 lifecycle listener
   并 reset Socket，再持久化 revocation fence；每个 HTTP/backoff 请求和 Socket continuation 在物理外发
   前重验初始化期 permit，旧账户 continuation 不得借新登录外发。fence 写入失败时不得提交 proof。
   challenge `409` 表示另一设备已进入可靠删除队列，必须先完成本地撤销再报告 pending；`401/403` 在
   proof 创建前失败，不撤销。成功、删除已进入可靠队列，或提交单次
   proof 后遇到网络/5xx/超时等不确定结果时，都只清本地认证、同步和 push 状态，不再向已删除账户发送
   远程 push-token 注销请求；revocation 或未完成 bootstrap fence 存在、读取失败或竞争时，启动恢复和
   开发 E2E bootstrap 一律 fail-closed，不得恢复旧凭据。不确定结果不得声称账户仍可用。普通登出在
   本地撤销后只允许一次 best-effort push-token DELETE，不得保留旧凭据的无限后台重试。不新增导出 UI/API。
6. [x] 更新所有 App locale、隐私政策、API、后端架构、部署与 Server README。托管端写明三天备份/
   日志保留目标和旧 S3 直传排空栅栏；自托管文档写明部署者须对其所有副本和生命周期规则负责。
7. [x] Voice conversation token 使用持久 admission：provider mint 前创建 fence，签名 JWT 的 `exp`
   在响应发送前持久化，发送时持有 Account 锁，删除器等待已成功发出的 token 到期；并发回归覆盖账户
   删除等待、失败释放和凭据有效期。
8. [x] 为账户读取、附件流起点、Push token/dispatch、Presence flush 与 Socket RPC 增加账户行准入。
   附件上传继续使用可阻塞最终删除的持久 operation；下载流、Expo 和远端 RPC 明确采用“删除后不再新准入，
   删除前已准入可完成或尽力中止”的跨系统边界。
9. [x] GitHub OAuth params 在同一 Serializable 事务中取得账户写入准入、生成绑定 admission 的 state
   并持久化 admission，只有事务成功后才返回 state；callback 只在原子 claim 成功后访问 GitHub，已知
   结果在返回重定向前持久结算。claim 重放和删除先赢路径不产生外部请求，token POST 的传输或解析结果
   未知时 admission 保持未结算。GitHub disconnect、Artifact、Push、Fastify 请求失败、受控调试、迁移
   和 retry 运维日志只保留 diagnostic hash、固定分类、状态和计数；hostile sentinel 回归覆盖原始 ID、
   token、body、data key、provider error 与堆栈不进入日志。
10. [x] Artifact mutation 在同一事务分配全局 `updateSeq` 并递增专用 `Account.artifactRevision`；重复
   create 返回原行且不分配序号或发送事件；跨账户同 ID 并发 create 的唯一键竞争会在新的账户门控事务
   中重读并明确结算为幂等成功或冲突，归属无法证明时失败关闭。签名、账户绑定的分页 cursor 固定 watermark 与 artifact
   revision；Artifact mutation 使续页 409 并从首页重启，无关账户写入不打断分页。App 只有完整取得所有页
   后才按 watermark 收敛缺席项并清除对象/key；单对象权威读取会原子提交响应的 `updateSeq`，快照或读取后的
   较新 lifecycle event 不被旧事件覆盖，异常、重复 ID、
   空/重复 cursor、跨账户迟到响应和中途 quarantine 的候选 key 都有 fail-closed 回归。
11. [x] 托管维护者于 2026-08-14 直接确认旧 S3 直传版本已从所有副本下线并记录
   `ACCOUNT_DELETION_LEGACY_DIRECT_UPLOADS_DRAINED_AT`，账户相关备份和运维日志保留上限为三天，且已检查
   一次实际删除后的对象、日志和备份结果。精确配置版本、执行时间和证据保留在受控运维记录；自托管不由本项目
   代为配置或验收。

## 验收标准

- 所有账户关系、GitHub OAuth token/profile 与两个对象前缀都有代码路径；完成状态前不删除持久请求，
  完成后不保留账户数据。
- 删除挑战需要账户凭据、匹配公钥、有效期和一次性消费；错误账户、重放与 terminal credential
  都有自动化测试，且不会发起数据库或对象删除。
- 删除开始后旧普通 token、终端 token、Socket.IO 连接和活动缓存失效，并拒绝新的认证和 mutation
  准入；删除标记前已经进入处理器的普通数据库写入允许先完成，但最终事务必须重新读取并清除；账户不能通过普通
  `/v1/auth` 自动重新获得 token，直到主数据删除完成。
- Voice 外部调用前必须取得账户 admission；删除确认等待活跃 admission 归零，确保删除标记后不会
  签发或返回新的第三方 conversation token。
- GitHub OAuth 删除先赢时不签 state；callback claim 失败或重放时不访问 GitHub，已 claim callback
  只有明确持久结算后才允许删除继续，token POST 的传输或解析结果未知不能因 state TTL 到期而自动放行。
- App 在 proof 提交前必须同步终止账户外发 generation、全部 Sync 队列、v4/git sync、App/Web listener
  与 user-scoped Socket，并完成持久 revocation fence；所有 token-bound HTTP/backoff 与 Socket/RPC 路径
  在物理外发前重验初始化期 permit。`409` pending 先本地撤销，`401/403` 不撤销；revocation 或
  bootstrap-pending fence 存在、读取失败或发生竞争时，不得自动恢复凭据、启动 Sync 或提交开发 E2E
  bootstrap。普通登出对旧 push token 最多发一次 best-effort DELETE，不得超时后继续后台重试。
- Artifact REST/Socket create、update、delete 在账户写入事务中分配用户级 `updateSeq` 并递增专用
  `Account.artifactRevision`，响应和 update envelope 使用同一序号；重复 create 不分配、不发事件，跨账户
  同 ID 并发 create 必须明确返回冲突，不能落入通用 500。签名
  cursor 的完整分页允许漏收 delete 后按 watermark 删除缺席对象与 key；无关账户序号变化不能使分页
  饥饿，Artifact mutation 必须使续页重启，较新 lifecycle event 不得被旧快照覆盖。App 删除 tombstone
  必须阻止较旧 update 与延迟 fetch 复活对象；单对象权威读取必须推进 lifecycle `updateSeq`，使随后迟到的
  较旧 update 不能覆盖读取结果，只有更大的 `new-artifact` 序号可以越过 tombstone。
- 对象存储删除失败会保持账户锁定并被重试；日志只记录固定事件和哈希化账户标识，不记录挑战、
  token、签名、原始账户/会话/artifact/provider ID、外部错误或内容。
- S3 升级在旧直传签发器排空前不能开始新的账户删除；此前已获准的代理上传会保持持久 pending
  直到对象存储确认成功，历史 orphan 附件、所有对象版本和 delete marker 都不会在最终 sweep 后留下对象，且
  全桶 orphan 扫描不随每个重试重复执行。
- 附件和头像的当前访问路径经 Server；S3 bucket 保持私有，带 Bearer 的附件 URL 不会将 token
  发送给未配置的 proxy/object-storage origin。
- 删除标记后不会新开附件下载流、读取 Push token、写入 Presence 或派发 RPC；标记前已经打开的流和
  已交给 Socket/Expo/provider 的外部动作不作跨系统撤回承诺，最终账户删除也不能被表述为第三方已送达
  数据的删除证明。
- App 确认、全部 locale、隐私/API/部署说明和包版本与实现同步；App 与 Server 的 patch release
  在对应 GitHub Actions 工作流通过后才作为可交付行为。
- migration CI 使用真实 PostgreSQL、两个独立 Prisma client 和 Serializable retry 验证两种顺序：
  callback claim 先提交时删除保持 pending；删除先提交时 claim 失败且 callback 不访问 GitHub。全部
  migration 必须在同一专用测试库从空库和历史基线执行并通过 drift 校验；同一 job 还必须强制两个账户
  同时创建相同 Artifact ID，并证明只创建一次、只分配一次序号，另一方明确返回跨账户冲突。
- 托管三天备份/日志保留已由维护者 2026-08-14 的直接运维验收关闭；仓库不复制其配置或记录。自托管副本
  保留责任持续明确归属部署者。
