# ADR-005: 由 daemon 执行同源只读恢复资格预检

## 状态

Accepted

## 日期

2026-08-06

## 背景

App 首页曾把所有“非活跃且未归档”的 Codex Sync v4 会话标为可恢复，并仅在用户点击
Resume 后才让原机器 daemon 验证真实恢复条件。这个展示规则没有检查独立会话密钥、
Relay snapshot、原机器归属、Codex thread、工作目录或 Gateway 冲突，因此会把大量只读
历史记录误报为可恢复。

恢复资格不能由 `active`、`archivedAt`、Socket 连接、运行时 `unknown`、经过时间或本地
App metadata 单独推断。真正 Resume 已有权威检查，但直接调用它会改变会话生命周期、
取消归档或启动 Gateway，不适合作为首页探测。我们需要一个与 Resume 共用证据和绑定
校验、但不执行恢复动作的预检边界。

## 决策

### 加密 machine RPC 与能力协商

CLI daemon 注册 `preflight-resume-sessions` machine RPC，并通过
`resumeSupport.preflightRpcAvailable` 单独声明能力。旧 CLI 即使支持 Resume 但不支持预检，
App 也只能把候选会话显示为待验证，不得回退到旧的生命周期推断。

每次请求包含 `1..25` 个候选项。每项仅携带有界的 `sessionId`、`directory`、`threadId`
和 Base64 编码的独立 `dataEncryptionKey`；handler 必须确认密钥解码后恰好为 32 字节。
响应只包含 session ID、资格类别和稳定原因，不返回路径、thread ID、snapshot、密钥、
provider 原始错误或异常堆栈。Machine RPC 的既有加密 envelope 保护传输；密钥只存在于
App 请求构造和 daemon 局部变量，不进入 Zustand、metadata、磁盘或日志。

### 同源只读检查

daemon 对每个候选执行以下检查，并保持输入顺序和逐项故障隔离：

1. 使用独立 data key 从 Relay 只读取得加密 session snapshot，不安装到 daemon 的 session
   map，也不写回 Relay。
2. 复用真正 Resume 的 binding validator，验证原机器、machine deletion、
   `flavor=codex`、`codexSyncVersion=4`、metadata machine、thread ID 和规范化 cwd。
3. 通过 stable-v2 `thread/read`、`includeTurns:false`、`emitSnapshot:false` 验证官方根
   thread 仍存在、cwd 一致并取得权威 provider 状态。
4. 只读检查已验证 Gateway descriptor、control status 和当前 worker/provider binding，
   再用与 Resume 相同的 launch-decision 规则分类冲突。

`CodexThreadHistoryService.inspect()` 为了可靠验证 provider thread，可以按既有空闲策略
创建或复用一个只读 app-server client。若本机尚无 history client，这会派生
`codex app-server --listen stdio://` 进程，并在空闲期内保留连接；这是获得官方
`thread/read` 证据所接受的有限资源代价，不等于启动或恢复 provider thread。检查不得
调用 `thread/resume`、`thread/start`、open coordinator 或任何 provider 写操作。

预检还严禁调用 `installSessionSnapshot`、unarchive、Gateway reconcile、launch、resume、
stop，或修改 Happy session 的 active/archive 生命周期。已匹配的活跃 Gateway 只返回
`alreadyActive`，由 App 刷新 session 投影，不把该记录标为可恢复。

### 结果与错误分类

- `eligible`：独立密钥、snapshot、binding、官方 thread 和 Gateway/provider 状态全部通过，
  且当前可进入真正 Resume。
- `ineligible/threadUnavailable`：官方 thread 明确不存在。
- `ineligible/invalidBinding`：snapshot 明确不存在，或密钥、机器、metadata、thread、cwd
  绑定明确不成立。
- `pending/relayUnavailable`：Relay 请求、鉴权、页面解析或解密暂时失败。
- `pending/providerUnavailable`：app-server 或官方 RPC 暂时无法给出结论。
- `pending/gatewayRecovering`：Gateway 检查失败、进程切换或恢复中。
- `pending/externalThreadActive`：provider thread 活跃，但没有匹配的已验证 Gateway。
- `alreadyActive`：已验证 Gateway 正承载同一 binding。

暂态异常不得转换为终态不可恢复。特别是 Relay `loadSnapshot` 抛错与 snapshot 明确返回
不存在必须区分；前者保留在待验证，后者才可隐藏为无效绑定。

### App 短期投影

App 将结果保存在不持久化、不跨设备同步的内存投影中。资格指纹覆盖 session 生命周期、
归档、原机器、provider/Sync 版本、只读标志、path、thread、机器在线状态和 capability。
同一个 `sessionId + fingerprint` 的并发请求合并；旧指纹请求完成后不得覆盖新投影。

资格 TTL 为 20 秒，从该批请求开始检查的时间计算，而不是从 RPC 回包时间计算。慢请求
不能在完成后额外获得一个完整 TTL；若结果抵达时已经过期，App 立即保持保守状态并发起
下一轮检查。只有当前指纹下仍新鲜的 `eligible` 才进入首页“可恢复”分区并显示 Resume。
未检查、检查中、已过期、离线、旧 CLI 和暂态故障进入“待验证”；明确 `ineligible` 的
记录从首页隐藏，但 session、消息和直接只读访问不删除。

### 最终 Resume 仍为权威操作

用户点击 Resume 后，App 强制绕过资格缓存重新预检。预检通过后，真正
`resume-happy-session` RPC 仍重新读取 snapshot、验证独立 key、machine/thread/cwd binding、
官方 provider 状态和 Gateway 状态，再执行允许的 unarchive/reconcile/launch。预检是短期
展示和操作门禁，不是授权票据，也不能消除检查与执行之间的竞争。

真正 Resume 返回 `threadUnavailable` 或 `invalidBinding` 时，App 可立即把当前指纹标为
终态不可恢复；`gatewayRecovering`、`externalThreadActive`、`operationFailed` 和
`outcomeUnknown` 只能回到待验证。Transport loss、RPC timeout 或经过时间永远不代表恢复
成功、失败或 provider turn 完成。

## 替代方案

### 继续使用 App 本地字段推断

拒绝。本地字段只能排除显然不支持的候选，无法证明 Relay snapshot 可解密、官方 thread
存在、cwd 正确或 Gateway 无冲突。严格保守时它又会让所有历史记录都无法确认。

### 在首页直接调用真正 Resume

拒绝。Resume 会取消归档、安装 snapshot、协调或启动 Gateway，并改变用户没有明确请求
修改的会话状态。

### 不启动 app-server，只检查本地文件或 Gateway descriptor

拒绝作为“可恢复”证据。本地文件和 descriptor 不能权威证明官方 stable-v2 thread 仍可
读取。若 app-server 无法提供只读 `thread/read`，结果必须是 pending，而不是 eligible。

### 将资格写入 session metadata 或 Relay

拒绝。资格是易失的同机运行时事实，持久化会制造跨设备陈旧承诺，并扩大密钥和 provider
状态的同步面。

## 后果

- 浏览历史列表可能启动一个按既有空闲策略回收的只读 Codex app-server client；这是可靠
  thread 存在性检查的明确资源成本。
- 首页会多出“待验证”分区，旧 CLI、离线机器和暂态故障不再被误称为可恢复。
- 明确不可恢复的记录不再占据首页，但仍保留为可直接访问的只读历史数据。
- App 与 CLI 各新增一个 patch 版本；Wire 和 Server schema 不变，旧 daemon 会通过缺失
  capability 保守降级。
- 20 秒资格只能减少误导和无效点击，不能替代真正 Resume 的完整校验。

## 回滚

App 回滚时，CLI 的额外 capability 和 RPC 可以保留但无人调用。CLI 回滚时，App 看到
`preflightRpcAvailable !== true` 后只显示待验证，不调用未知 RPC，也不恢复生命周期推断。
任何回滚都不删除 session、Sync v4 entity、Relay snapshot 或历史消息。

## 验证

- CLI 覆盖 RPC 批量/字段/密钥边界、Relay 暂态与 snapshot missing、thread/binding、Gateway
  live/recovering/external active、逐项隔离和顺序。
- App 覆盖指纹、请求起点 TTL、同指纹 in-flight 合并、旧指纹回包丢弃、批量响应 schema、
  首页 eligible/pending/ineligible/archived 分区，以及点击前强制预检。
- 真正 Resume 的既有测试继续验证预检无法绕过 snapshot、binding、provider 或 Gateway
  权威检查。
