# Codex 悬浮待发送条与队列管理计划

## 状态

- 当前状态：已完成并归档。实现提交 `62f09e35bcfe19dbd3e02355c5a417a66ebb75b8`
  已包含于 `origin/main@28d053713e09e3ddf0f9674c024f38995f65807f`；本文不再将“等待合入/统一发布”表述为当前工作。
- 视觉目标：Agent 执行期间使用贴在输入框上沿的紧凑待发送层，桌面与手机保持同一信息层级。
- 范围：App composer/队列交互、CLI Sync v4 队列取消语义及全部 App 翻译。

## 交互契约

- 未发送草稿继续留在主输入框；紧凑的“排队/引导”控件控制下一次提交。
- 已提交但尚未执行的消息按 FIFO 显示单行预览、引导、移除和更多操作。
- 最多直接显示 3 条，超出部分在受限滚动区域或菜单中访问；不支持重排。
- 更多菜单提供编辑、发送到当前轮次和移除；并发状态变化时刷新权威队列并提示失败。
- 控件使用 radio/button 语义、稳定焦点顺序和至少 44px 触控区域。

## 协议契约

- 新增 `turn.queue.cancel` 命令，可原子取消已持久化且仍未被执行器认领的
  `turn.queue`（状态为 `received` 或尚未写入状态）；`executing`、终态或身份不匹配一律拒绝。
- 取消命令沿用 `queueEntryId`、`queuedAt`、`bindingGeneration` 和 `replacesCommandId`；
  CLI 原子取消原命令并在本地成功，不向供应商发送空输入。
- Wire 的 command 字段已允许受控扩展字符串；为可判别的取消结果新增稳定
  `queueCancelled` 原因枚举，Wire 版本仍保持 `0.1.8`。

## 待完成

- [x] 将模式控件移出输入框 surface，并实现响应式待发送消息层。
- [x] 增加编辑、引导、移除和多消息菜单，保持主 composer 尺寸稳定。
- [x] 实现 App `sessionCancelCodexQueuedMessage` 与 CLI `turn.queue.cancel`。
- [x] 更新全部支持语言并运行翻译一致性检查。
- [x] 增加 App projection/ops、CLI processor 和交互测试。
- [x] 使用桌面、375px 与 320px Playwright 截图验收布局和遮挡。
- [x] 在集成分支运行 monorepo CI，记录结果后归档。

## 本地验证证据

- Wire schema：`syncV4Entities.test.ts` 8/8；CLI processor：18/18；App queue
  projection/ops：39/39；三个受影响包的 `tsc --noEmit` 均通过。
- Playwright 临时路由验证了桌面、375px、320px：最多三条的滚动视口、更多菜单、
  编辑弹层、移除竞争失败提示、radio 的鼠标/键盘操作及 `aria-checked`，以及自动补全层
  位于待发送层之上。最终复验确认两个 radio 均为 `91×44px`，方向键切换后焦点、
  `aria-checked` 与 roving `tabindex` 同步收敛；临时路由和开发服务器已删除。

## 云端验收证据

- [Documentation knowledge base](https://github.com/KNaiFen/happy/actions/runs/31066864614) 通过。
- [Happy monorepo CI](https://github.com/KNaiFen/happy/actions/runs/31066864724) 在同一
  `62f09e35` HEAD 全绿：CLI、Wire、Server、App、fake-provider 恢复、官方 Codex
  app-server 生命周期、真实 TUI 11 分钟空闲/附着/停止以及 Required CI gate 均成功。

## 验收标准

- 排队/引导不再与输入框镶嵌，队列层在键盘、自动补全和状态栏出现时不重叠。
- 编辑、引导和移除在断线重连后仍由 durable Sync v4 状态收敛。
- 已被执行的消息不能被误删，取消不会生成供应商用户消息。
