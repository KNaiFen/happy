# App 排队消息连续堆叠与锚定菜单实施计划

## 状态

- 当前状态：进行中，代码、源码验证、翻译比较、文档索引与独立审查已完成；等待提交、推送和干净云端环境的 Actions 验收。
- 建立日期：2026-08-07。
- 实施分支：`fix/app-queue-resume-eligibility`。
- 基线：`origin/main@ff784dcfd24e617d59d555380296bbd40e91c8da`。
- 目标版本：`packages/happy-app` `1.11.36`。
- 关联决策：恢复资格的产品边界以 [ADR-005](../decisions/ADR-005-daemon-resume-eligibility-preflight.md) 为准；本计划只改 App 的队列呈现和队列操作菜单，不放宽恢复资格判断。

## 背景与现场依据

用户提供的 A、B 图以及对 C 图的补充说明代表同一个 App composer 体验的三个观察点：

- **A 图是错误现状**：队列消息被画成互相独立的白色悬浮卡片。卡片之间出现页面背景，卡片底边与输入框上圆角之间还有空隙；圆角、阴影和输入框的玻璃材质也不统一。输入框上方不应再显示 Queue/Steer 模式选择器，活动 Codex 回合的普通发送默认进入 durable queue。
- **B 图是视觉参考**：队列区域是输入框上方的连续层叠面，消息行更紧凑；每行仍保留引导、删除和 `…` 操作。队列左右比输入框略内缩，但最底层与输入框相接，不露出背景。输入框是前景，队列是后景。
- **C 图的关键补充**：这不是一个只有外层圆角的总容器。每一层消息都必须有清晰的上圆角；每层的实体背板向下延伸，覆盖下一层上圆角两侧以及最底层与输入框圆角之间的空隙。多条消息继续按同一规则逐层重叠。

首页历史会话的恢复资格问题已经由现有 Sync v4 资格投影、daemon 只读预检和 ADR-005 处理：只有仍新鲜的 `eligible` 才显示 Resume，明确不可恢复的记录隐藏但不删除，暂态结果进入待验证。此处只做回归确认，不把未知或旧 provider 数据重新标成可恢复。

## 目标

1. 保持活动 Codex v4 回合的普通发送固定为 `followUpMode: 'queue'`，不在 composer 中渲染 Queue/Steer 选择器。
2. 将排队消息改为与 composer 同一套输入材质、边界和层级语言的连续堆叠。
3. 每层显示上圆角并覆盖视觉空隙，最早消息贴近输入框，最多四层同时可见，更多消息可滚动访问。
4. 保留每条消息的引导、编辑、删除和 `…` 操作语义；操作进行中互斥并提供 disabled/busy 状态。
5. 将 `…` 菜单改为三端统一的自绘锚定浮层：跟随触发按钮，优先向下、空间不足向上，始终限制在安全区、键盘和窗口内。
6. 覆盖窄屏、键盘、顶部/底部/左右边缘、浅色/深色和 Web/原生平台的布局边界。

## 非目标与边界

- 不改 Sync v4 durable queue、FIFO 顺序、ACK/cursor、`queueEntryId`、取消或 steer 协议。
- 不拖拽重排消息，不改变消息投影的创建时间和身份。
- 不重新实现或放宽首页恢复资格；不把 `unknown`、旧 CLI、离线、暂态错误或无法验证的记录显示为可恢复。
- 不删除不可恢复的 session、历史消息、Relay snapshot 或密钥材料。
- 不使用原生 iOS action sheet、Android bottom sheet 或 Web 固定底部面板作为 `…` 菜单默认实现。
- 不在本地构建 Android、Web bundle、Tauri、CLI 发布包或官方 Codex；发行构建由 GitHub Actions 完成。

## 视觉与布局契约

### 1. 共同坐标和宽度

- `CodexQueuedMessages` 位于 composer 的正常文档流上方，不使用绝对定位把队列整体脱离输入区。
- 队列 dock 相对 composer 内容左右各内缩 `14dp`，对应 `followUpDock.paddingHorizontal = 14`。队列向下连接的背板/桥接面向左右各扩展 `14dp`，覆盖到 composer 的完整宽度。
- 队列的底部延伸由共享背板负责，不能通过 `marginBottom`、透明 padding 或额外的卡片间距制造缝隙。输入框自身的圆角和阴影仍由 `AgentInput` 负责。
- 队列父层允许视觉溢出，composer 外层使用更高的前景层级覆盖延伸区域；不得让父容器的 `overflow: hidden` 裁掉底部连接面。

### 2. 几何常量（dp）

这些常量必须集中在 `codexQueuedMessageStack.ts`，组件样式只能引用它们：

| 常量 | 数值 | 用途 |
| --- | ---: | --- |
| `CODEX_QUEUED_MESSAGE_HEIGHT` | `40` | 每层完整触控/内容行高度 |
| `CODEX_QUEUED_MESSAGE_STEP` | `29` | 相邻层的视觉步进 |
| `CODEX_QUEUED_MESSAGE_OVERLAP` | `11` | `height - step`，相邻层的重叠量 |
| `CODEX_QUEUED_MESSAGE_MAX_VISIBLE` | `4` | 视口内最多可见层数 |
| `CODEX_QUEUED_MESSAGE_TOP_RADIUS` | `20` | 每层上圆角和共享背板上圆角 |
| `CODEX_QUEUED_MESSAGE_JOIN_DEPTH` | `20` | 背板向 composer 方向延伸的深度 |
| `CODEX_QUEUED_MESSAGE_TOP_INSET` | `0` | 视口顶部不留可见页面背景 |
| `CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET` | `14` | dock 内缩与连接背板回扩使用同一个值，避免两侧露缝 |

高度公式必须保持可预测：

```text
visibleRows = min(max(floor(messageCount), 0), 4)
height = visibleRows == 0 ? 0 : 40 + (visibleRows - 1) * 29
```

因此 0/1/2/3/4 条分别为 `0/40/69/98/127dp`；5 条及以上仍为 `127dp`。消息总数超过四条时，初始滚动偏移为 `(messageCount - 4) * 29dp`，让最早、最接近执行端的消息贴住 composer。

### 3. 每层的绘制结构和层级

每个消息层按以下顺序实现，顺序是视觉契约的一部分：

1. **共享 stack backfill**：使用 `theme.colors.input.background`、`theme.colors.divider`；原生 glass 模式使用与 composer 相同的 glass background/border token。它从队列顶部贯穿到 `joinDepth`，负责填充所有圆角两侧的页面背景。
2. **每层 message cap**：每个层自己的顶部设置 `topLeft/topRight = 20dp`、上边框和左右边框；背板颜色必须与共享材质一致，不能透明到露出页面背景。cap 不画下边框，以便向下一层连续。
3. **message content**：单行文本、引导、删除和 `…` 控件在 cap 之上，文本尾部省略；空文本继续显示本地化附件占位。
4. **负 margin overlap**：除最上层外，层的顶部使用 `marginTop = -11dp`；视觉最上层的 z-index 最高，并向下覆盖下一层圆角的空隙，不能用 `gap` 把层分开。下层内容以 overlap 作为顶部安全 inset，避免被上层背板裁掉。
5. **composer 前景**：`AgentInput` 的 composer layer 使用高于队列的 z-index。输入框盖住队列延伸到 join 区域的下缘，形成“输入框在前、队列在后”的关系。

检查标准不是“外层看起来有一个圆角”，而是逐层检查：每个上圆角两侧的三角空白都被该层背板或共享 backfill 覆盖，最底层与输入框上圆角之间也没有页面背景色、透明缝或直线断裂。

### 4. 内容与操作

- 行内容保持单行，使用 `numberOfLines={1}` 和尾部省略，不因长文改变 `40dp` 行高。
- 删除和 `…` 的可视按钮保持 `28dp` 稳定盒子；引导使用固定 `68dp` 的图标加短标签盒子。每个控件用与自身可视宽度一致、横向不重叠的真实 `Pressable` 包装层承载，高度与 `40dp` 队列行齐高，图标操作宽度至少 `44dp`。不得用会被父层裁切或彼此竞争的 `hitSlop` 伪造触控范围，也不可为了挤下文本而让按钮随视口缩放。
- 引导不可用时保留禁用状态，不隐藏操作语义；请求进行中同一队列的其他操作禁用，当前操作显示 loading/busy。
- 视觉上的引导按钮使用 `queuedMessageSteerCompact` 短标签；无障碍 label、菜单项和 Web `title` 继续使用完整的 `queuedMessageSteer`。三端均提供 role、label、disabled/busy 状态。所有新增或修改的可见文案沿用 `sources/text/_all.ts` 及现有 locale，禁止硬编码可见标签。

## 锚定 `…` 菜单契约

### 1. 统一承载方式

- iOS、Android、Web 均使用全屏透明 `NativeModal` 承载自绘浮层和 click-away backdrop；不按平台分支回退为底部 sheet。
- backdrop 必须透明，不使用遮挡会话内容的深色蒙层。按返回键、`Esc` 或点击外部均关闭。
- 菜单使用同一套输入/玻璃材质，圆角 `14dp`、边框 hairline、轻量阴影；菜单项高度 `44dp`，默认宽度 `224dp`，内部 `ScrollView` 负责高度不足时滚动。

### 2. 测量和定位顺序

1. `…` 按钮保存 ref，点击后用 `measureInWindow` 获得 `{x, y, width, height}`；未获得有效尺寸时不打开菜单。
2. 计算安全边界：`left = safe.left + 8`、`right = viewport.width - safe.right - 8`、`top = safe.top + 8`、`bottom = viewport.height - safe.bottom - keyboardHeight - 8`。
3. 菜单优先在触发按钮下方展开，间距 `6dp`；下方放不下时翻转到上方，仍保持同一 `6dp` 间距。
4. 水平优先右边缘对齐触发按钮，若越过边界则改为左边缘对齐；仍越界时 clamp 到安全边界。窄屏时宽度降到可用宽度，不允许负宽或横向溢出。
5. 上下都不足时选择可用空间较大的一侧，把 `height/maxHeight` 限制为该侧空间，并让内部滚动承载完整菜单项。
6. 窗口旋转、键盘显示/隐藏或 safe-area 改变时重新计算；已打开菜单继续跟随原触发按钮的新坐标。

### 3. 菜单动作和关闭

- 菜单项顺序固定为 Edit、Steer、Remove，动作继续调用现有 `sessionUpdateCodexQueuedMessage`、`sessionSteerCodexQueuedMessage`、`sessionCancelCodexQueuedMessage`。
- 选择动作先关闭浮层，再进入现有互斥 action 状态；失败保持无 payload 日志和现有错误提示。
- 点击 backdrop 只调用 `onClose`，不能触发消息动作；菜单打开期间触发按钮和队列操作不会穿透。

## 恢复资格回归边界

本次视觉改造必须保持以下既有行为：

- 首页只有当前 fingerprint 下仍新鲜的 `eligible` session 显示 Resume。
- 未检查、检查中、TTL 过期、旧 CLI、离线和 Relay/provider/Gateway 暂态故障进入待验证，不显示可恢复承诺。
- 明确 `threadUnavailable`/`invalidBinding` 的记录从首页隐藏，但 session、历史消息和直接只读访问保留。
- Resume 点击前强制重新预检，真正 Resume 仍执行完整 thread、binding 和 Gateway 权威校验。
- 不得用 UI 菜单或队列更新改写 resume eligibility storage、metadata 或协议字段。

## 实现文件边界

- `sources/components/codexQueuedMessageStack.ts`：几何常量、层顺序、视口高度和 overflow offset。
- `sources/components/CodexQueuedMessages.tsx`：连续 backfill/cap/content 绘制、操作状态、按钮测量和菜单接线。
- `sources/components/AnchoredActionMenu.tsx`：跨平台自绘浮层、backdrop、键盘/返回键关闭和菜单项渲染。
- `sources/components/anchoredActionMenuPlacement.ts`：纯定位计算，禁止依赖 React Native 或窗口副作用。
- `sources/components/AgentInput.tsx`：队列 dock 与 composer 前景层级、横向内缩和溢出边界。
- `sources/components/*.test.ts`：几何和定位边界；协议与 projection 现有测试继续作为回归门槛。
- `packages/happy-app/package.json`：行为变更 patch 版本 `1.11.36`。
- `docs/plans/`：本计划在全部检查完成前保持活动；完成后移入 archive 并保留证据。

## 验证矩阵

### 源码与逻辑

- stack：0/1/2/3/4/5/7 条高度、顺序不可变、最新在上、最早贴 composer、overflow offset。
- placement：正常向下、底部翻转、顶部翻转、左右 clamp、安全区、键盘高度、窄屏宽度、菜单过高滚动。
- queue protocol：edit 保留 FIFO identity、steer、cancel、只读限制和错误状态。
- resume regression：eligibility fingerprint/TTL、旧 fingerprint 回包丢弃、首页 eligible/pending/ineligible 分区及最终 Resume 门禁。
- i18n：比较所有支持 locale 的 key 结构与参数，确认菜单/无障碍文案没有硬编码遗漏。

### 运行时视觉

对 Web 开发服务器及可用原生现场分别检查：

- 队列数量 `0/1/2/3/4/5+`；0 条完全不留 dock 占位，4 条恰好四层，5+ 条首屏仍贴最早消息且可向上滚动。
- 每层上圆角均可见，圆角两侧和最底层与 composer 之间无页面背景漏缝；输入框前景遮住 join backfill。
- 浅色/深色主题；窄屏 `320/375/408px`；键盘打开；锚点位于顶部、底部、左边和右边。
- `…` 菜单不固定屏幕底部，翻转和 clamp 后不越出 safe-area/键盘；点击外部、Esc、返回键关闭。
- 文本长短、禁用/忙碌/删除态、屏幕阅读器 label 和 Web title 不改变稳定盒子尺寸。

### 本机运行时验收记录

- 2026-08-07 已用 Playwright 打开隔离 worktree 的 Expo Web 服务。Metro 返回 HTTP 500，原因为 worktree 的 pnpm 符号链接布局下无法解析 `expo-router/entry`；页面未挂载，不能用空白截图为队列视觉背书。
- 重新启动独立服务时，Metro 又因 macOS watcher 上限返回 `EMFILE`；已有的失败进程经过 cwd 确认属于本 worktree，但系统拒绝停止该进程的权限请求，未绕过该限制。
- 因此本机只把 `tsc`、Vitest、翻译比较和 docs 检查作为有效证据。运行时队列视觉、键盘跟随和原生 safe-area 必须由干净 checkout 的 GitHub Actions 或可用真机现场复核。

### 命令门槛

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/codexQueuedMessageStack.test.ts \
  sources/components/anchoredActionMenu.test.ts \
  sources/sync/ops.codexQueue.test.ts \
  sources/sync/codexV4Projection.spec.ts
pnpm --filter happy-app exec tsc --noEmit
pnpm --filter happy-app exec tsx sources/scripts/compareTranslations.ts
pnpm docs:sync
pnpm docs:check
```

本机缺少全局 `pnpm` 时，使用仓库已有的 package-local binary 做等价源码检查，并在最终验证报告中列出实际命令；不以本地发行构建替代 Actions 证据。

## 当前未完成项

- [x] 连续堆叠几何与队列操作菜单实现。
- [x] 锚定定位 helper 与边缘边界测试。
- [x] App 类型检查与目标测试通过（使用 package-local binary 复核：Vitest `4` 文件/`46` 项、`tsc --noEmit --incremental false`）。
- [x] 调整 `happy-app` 到 `1.11.36` 并完成翻译比较；新增紧凑引导短标签已覆盖全部支持 locale。
- [x] 运行 `docs:sync`/`docs:check`，确认生成索引只包含已暂存快照。
- [ ] 完成干净环境的 Web/原生现场截图和 0/1/4/5+、主题、键盘、边缘菜单验收（本机阻塞原因见上）。
- [x] 完成 findings-first code review，已修复引导短标签撑破操作触控区的问题。
- [ ] 提交中文 commit、推送 `origin/main`，等待并记录匹配 Actions 终态。
- [ ] 成功后更新计划状态并移入 `docs/plans/archive/`。
