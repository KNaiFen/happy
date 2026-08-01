# Codex App 语义时间线去重与 Resume 焦点修复

## 状态

- 状态：已完成并归档
- 验收基线：`main@06a6b75`
- 目标版本：App `1.11.21`
- CLI、Server、Wire 保持当前版本；本轮仅修 CI 夹具，不重复发布 App

## 实施记录

- App 投影已改为 item 所有权的单一语义槽；关联审批、MCP 生命周期和 item revision 原位替换，历史 `mcpStartup` 不进入聊天。
- `/compact` 与 Review 生命周期已改为时间线分隔线；成功控制 ACK 隐藏，查询与失败结果保持紧凑行，失败的 compaction/review 不会被分隔线遮蔽。
- Resume、会话 composer 和新会话 picker 已复用键盘收起协调器，包含 hide 事件、420ms 兜底和 300ms 同键双击抑制。
- 云端 Responses fixture 已修正两个假阳性：历史预热不再消耗实时 MCP 覆盖，实时回复使用独立 sentinel；Android field 会直接在键盘可见时 Resume，观察唯一 Happy MCP 卡片，执行 `/compact`，并在 App 重启后复验。
- 本地源码验证：App 全量 Vitest `963/963`、fixture `2/2`、翻译键 `830/830`、App 与官方 Codex CI TypeScript 检查、YAML/shell 解析及 `git diff --check` 均通过。源码 HTTP relay 场景通过归档恢复、事件顺序、首命令、零 v3 回退、轮询/重连、审批、子线程、隐私、10,000+ entity、20 次 delta 和 `241.9ms` p95。
- 首轮云端结果：Monorepo CI 与 App `1.11.21` Android release 已通过；官方 Codex Android field 在 Happy MCP 卡片断言失败。产物证明 CLI bridge 与 app-server MCP startup 均正常，但 provider 请求计数停在 3，MCP call/output 均为 0。
- 根因：本次云端编译的官方 `codex-cli 0.146.0` 使用 Responses namespace 工具结构 `type=namespace -> tools[]`；夹具只识别顶层或 `function.name`，未选择 namespace 内的 `change_title`，因此错误返回普通最终回复。产品的 `thread/resume` 已正确传递 `config.mcp_servers`，无需修改 CLI。
- 修复：夹具同时解析扁平 function 与 namespace 子工具；向官方 app-server 返回 namespaced `function_call` 时保留 `namespace` 字段，并记录不含参数/输出的 namespace 覆盖计数。单元测试分别固定扁平与 namespace 两种协议形态，Android field 仍必须完成真实 Happy MCP provider call/output、唯一 UI 卡片、compact 和重启恢复。
- 第一轮夹具源码验证：Responses fixture `3/3`、官方 Codex CI TypeScript、field shell 语法与 `git diff --check` 均通过。
- 第二轮云端结果：提交 `091a503` 的 Monorepo CI `30718655386` 全绿；Android field `30718655368` 诊断记录 `providerNamespaceToolOfferCount=5`、`providerHappyMcpOfferCount=0`，证明 namespace 解析已生效，但严格身份匹配仍未选中 Happy 工具。
- 根因修正：官方 `0.146.0` 默认启用 `NonPrefixedMcpToolNames` 时，Happy MCP 的模型可见 namespace 是 `happy`；旧版/旧配置才是 `mcp__happy`。子工具均为 `change_title`。夹具不得把旧 `mcp__` 前缀当成唯一合法形式。
- 二次修复：只接受精确的 `(happy, change_title)` 与 `(mcp__happy, change_title)` namespace 组合，以及对应的扁平 `happy__change_title`/`mcp__happy__change_title`；负向用例固定拒绝裸名、子串和相似名称。新旧 namespace/扁平 fixture `6/6`、官方 Codex CI TypeScript、field shell 与 diff 检查均通过。等待下一轮官方 Codex Android field 复验通过后归档本计划。
- 第三轮云端结果：提交 `74724a9` 的 Monorepo CI `30719878578` 全绿；Android field `30719878544` 仍记录 5 个 namespace 子工具且没有 Happy offer/call。官方源码确认这 5 个是 direct collaboration 工具，不能据此推断 Happy namespace 的具体拼写。
- 完整根因：官方 `0.146.0` 在 `tool_search` 启用时把普通 MCP runtime 标记为 deferred。首个 Responses 请求只声明 `type=tool_search`，Happy `change_title` 仅在 provider 发出 `tool_search_call`、Codex 执行 BM25 并回传 `tool_search_output` 后可见。旧夹具既未识别 `type=tool_search`，也未处理 search output，因此前两次 namespace 修正无法触达真实 Happy 工具。
- 三次修复：fixture 按官方事件形态执行 `tool_search_call -> tool_search_output -> namespaced function_call -> function_call_output`；优先兼容旧版直接暴露的 Happy 工具，search 仅在 direct offer 不存在时执行。诊断 schema 记录 search call/output，但最终门禁仍以真实 Happy offer、MCP call/output、唯一 App 卡片、compact 与重启恢复为准，避免把 search 本身误当业务成功。
- 三次修复本地验证：Responses fixture `7/7`（含种子 shell 隔离和完整 deferred tool-search 往返）、官方 Codex CI TypeScript、field shell 语法与 `git diff --check` 均通过。
- 第四轮云端结果：提交 `e186889` 的 Monorepo CI `30721479746` 全绿；Android field `30721479743` 的主流程 `2m29s` 通过，schema 5 记录 `tool_search=1/1`、Happy offer/call/output 均成功、零 v3 回退，并通过唯一 MCP 卡片、compact 与首次 App 重启断言。随后独立进程死亡恢复流失败在查找旧标题 `New chat`；失败截图明确显示真实 Happy `change_title` 已将持久化会话标题更新为 `MCP single-card field verification`，会话本身仍在列表中。
- 四次修复：recovery 流不再依赖被真实 MCP 主动替换掉的初始标题，改为等待并打开 `MCP single-card field verification`，使该步骤同时验证标题和会话在进程死亡后恢复，再继续核对种子历史与官方回复。
- 最终云端验收：提交 `06a6b75` 的 Monorepo CI `30722923182` 与 Android field `30722923181` 全绿。field 从官方源码固定构建 `codex-cli 0.146.0`，schema 5 证明 5 次 provider 请求、一次 tool-search call/output、一次真实 Happy offer/call/output、零 v3 消息；zero-machine bootstrap、零设备 App 入口、MCP/compact 主流程和 19 秒进程死亡恢复四份 JUnit 均为 `failures=0`。

## 目标

- 一个 Codex 语义动作只产生一个聊天节点，消除 MCP、审批、控制命令和官方 item 的重复展示。
- `/compact` 保留用户命令，并用一个居中的“上下文压缩”分隔线表示官方 compaction；隐藏成功控制 ACK 和内部工具名。
- Review 进入/退出使用分隔线；查询、失败、warning 和未知内部 item 默认折叠，不隐藏真实错误或交互请求。
- 输入路径后直接打开 Resume 时，先稳定收起键盘，再打开唯一的线程选择 sheet。

## 投影规则

```text
Codex item + linked request + revisions
                  |
                  v
       SemanticTimelineNode(itemId)
          pending -> approval only
          approved -> tool at same position
          completed -> update same tool
          denied -> compact outcome

/compact command -> user bubble
success ACK      -> hidden
compaction item  -> timeline divider
```

- 使用 `(threadId, turnId, itemId)` 作为 item/request 的语义所有权键；MCP started/progress/completed 保持同一消息 ID 和排序位置。
- 同一 item 有未解决审批时只显示审批卡；批准后原位置替换为真实工具，拒绝或取消后保留紧凑结果。同一 item 的多个请求收纳在一张审批卡中。
- 独立 tool user-input/MCP elicitation 继续作为独立交互消息。
- 隐藏成功控制 ACK、历史 `mcpStartup` 和已有 relation/delegation 对应的冗余 activity；失败永不隐藏。
- context compaction、进入 Review、退出 Review 使用稳定时间线事件；分组层不得吞掉、复制或移动这些边界。
- plan/diff 同 turn 同时存在官方 item 与保留 synthetic item 时优先官方 item。
- stable-v2 已知 item 使用表驱动策略；未知内部 item 使用默认折叠行，不再直接展开原始 JSON。

## Resume 焦点

- 抽取共享的“收起键盘后打开界面”逻辑，复用现有 composer picker 和机器 Resume 入口。
- 原生端监听 `keyboardDidHide`，保留 420ms 兜底；Web blur 后立即打开。
- 连续点击只执行一次，卸载时清理订阅和 timer，sheet 打开期间不重新聚焦底层输入框。

## 验收

- App 源码测试覆盖增量、乱序、snapshot、重启、MCP 生命周期、关联审批、多请求、compaction/review 分隔线和消息分组唯一性。
- 键盘测试覆盖已隐藏、hide 事件、超时、双击、卸载与 Web；Android field 直接在键盘可见时点击 Resume。
- 官方 Codex 云端场景执行 `/compact` 与真实 Happy MCP 调用，验证 live、完成、snapshot 和 App 重启后均只有一个语义节点。
- 更新全部 10 个 locale，运行翻译比较、App 源码 Vitest 与 `tsc --noEmit`；构建和 Android 验收只在 GitHub Actions 执行。

## 发布

- App patch 已推进到 `1.11.21`，Android release `30716908465` 已通过。
- 最终 Monorepo CI `30722923182` 与官方 Codex Android field `30722923181` 已通过。
- 计划已记录验证证据并移入 `docs/plans/archive/`；本地 `.agents` 已同步但不提交。
