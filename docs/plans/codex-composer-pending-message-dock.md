# Codex 悬浮待发送条与队列管理计划

## 状态

- 当前状态：进行中；旧会话恢复已通过完整 CI 并归档，开始核验现有队列真值与 composer 布局。
- 视觉目标：Agent 执行期间使用贴在输入框上沿的紧凑待发送层，桌面与手机保持同一信息层级。
- 范围：App composer/队列交互、CLI Sync v4 队列取消语义及全部 App 翻译。

## 交互契约

- 未发送草稿继续留在主输入框；紧凑的“排队/引导”控件控制下一次提交。
- 已提交但尚未执行的消息按 FIFO 显示单行预览、引导、移除和更多操作。
- 最多直接显示 3 条，超出部分在受限滚动区域或菜单中访问；不支持重排。
- 更多菜单提供编辑、发送到当前轮次和移除；并发状态变化时刷新权威队列并提示失败。
- 控件使用 radio/button 语义、稳定焦点顺序和至少 44px 触控区域。

## 协议契约

- 新增 `turn.queue.cancel` 命令，只能替换仍为 `received` 的 `turn.queue`。
- 取消命令沿用 `queueEntryId`、`queuedAt`、`bindingGeneration` 和 `replacesCommandId`；
  CLI 原子取消原命令并在本地成功，不向供应商发送空输入。
- Wire 的 command 字段已允许受控扩展字符串，因此不修改 Wire schema 或版本。

## 待完成

- [ ] 将模式控件移出输入框 surface，并实现响应式待发送消息层。
- [ ] 增加编辑、引导、移除和多消息菜单，保持主 composer 尺寸稳定。
- [ ] 实现 App `sessionCancelCodexQueuedMessage` 与 CLI `turn.queue.cancel`。
- [ ] 更新全部支持语言并运行翻译一致性检查。
- [ ] 增加 App projection/ops、CLI processor 和交互测试。
- [ ] 使用桌面、375px 与 320px Playwright 截图验收布局和遮挡。

## 验收标准

- 排队/引导不再与输入框镶嵌，队列层在键盘、自动补全和状态栏出现时不重叠。
- 编辑、引导和移除在断线重连后仍由 durable Sync v4 状态收敛。
- 已被执行的消息不能被误删，取消不会生成供应商用户消息。
