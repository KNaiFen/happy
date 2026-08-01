# Codex App 语义时间线去重与 Resume 焦点修复

## 状态

- 状态：本地实现完成，等待云端验收
- 基线：`main@a09dc569`
- 目标版本：App `1.11.21`
- CLI、Server、Wire 保持当前版本

## 实施记录

- App 投影已改为 item 所有权的单一语义槽；关联审批、MCP 生命周期和 item revision 原位替换，历史 `mcpStartup` 不进入聊天。
- `/compact` 与 Review 生命周期已改为时间线分隔线；成功控制 ACK 隐藏，查询与失败结果保持紧凑行，失败的 compaction/review 不会被分隔线遮蔽。
- Resume、会话 composer 和新会话 picker 已复用键盘收起协调器，包含 hide 事件、420ms 兜底和 300ms 同键双击抑制。
- 云端 Responses fixture 已修正两个假阳性：历史预热不再消耗实时 MCP 覆盖，实时回复使用独立 sentinel；Android field 会直接在键盘可见时 Resume，观察唯一 Happy MCP 卡片，执行 `/compact`，并在 App 重启后复验。
- 本地源码验证：App 全量 Vitest `963/963`、fixture `2/2`、翻译键 `830/830`、App 与官方 Codex CI TypeScript 检查、YAML/shell 解析及 `git diff --check` 均通过。源码 HTTP relay 场景通过归档恢复、事件顺序、首命令、零 v3 回退、轮询/重连、审批、子线程、隐私、10,000+ entity、20 次 delta 和 `241.9ms` p95。
- 待办：推送 `origin/main`，等待 Monorepo CI、官方 Codex、Android field 与 App `1.11.21` release 全部通过后归档本计划。

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

- App patch 推进到 `1.11.21`，使用中文提交并推送 `origin/main`。
- 等待 Monorepo CI、官方 Codex 场景、Android field 和 Android release 全绿；失败时修复并按发布规则推进新 patch。
- 完成后记录验证证据并移入 `docs/plans/archive/`；同步本地 `.agents`，但不提交本地 AI 文件。
