# Phase 6: Chat Composer Controls And Popover Motion - Context

**Gathered:** 2026-08-15
**Status:** Ready for planning

<domain>
## Phase Boundary

本阶段只调整 Happy App 聊天页现有权限、模型与思考程度控件的输入区布局、选择窗口关系及开合生命周期。交付目标是三个控件稳定地位于消息发送框上方，并让权限、模型和思考程度窗口在受支持的平台与聊天页面尺寸下无背景闪烁、具有平滑动画且不重叠、不溢出。本阶段不增加新的模型、权限类型、思考程度、会话能力或设置入口。

</domain>

<decisions>
## Implementation Decisions

### 控件行与窄屏适配
- **D-01:** 权限、模型、思考程度三个控件保持单行，并按照权限、模型、思考程度的顺序从左向右排列；最右侧保留协调间距。
- **D-02:** 权限和思考程度控件保持完整显示；空间不足时由模型控件吸收宽度压缩，不换行、不横向滚动。
- **D-03:** 模型名称采用中间截断，同时保留名称首尾；完整名称在模型窗口中展示，当前模型带选中标记。
- **D-04:** 三个控件平时只显示当前选中值，不增加字段名前缀或额外图标，并沿用当前权限组件的视觉语言。

### 弹窗内容与选择行为
- **D-05:** 权限控件打开独立权限窗口；模型与思考程度控件打开同一个组合窗口。
- **D-06:** 组合窗口根据触发控件调整内容顺序：点击模型时模型部分优先，点击思考程度时思考程度部分优先，另一部分紧随其后。
- **D-07:** 选择权限或思考程度后立即关闭对应窗口；选择模型后组合窗口保持打开，让用户查看或继续调整思考程度。
- **D-08:** 新模型不支持当前思考程度时，沿用自动回退逻辑切换到受支持的默认程度，并在保持打开的窗口中明确更新选中状态。

### 跨平台弹窗形态
- **D-09:** 移动原生端复用旧版权限按钮使用的原生菜单生命周期：iOS 使用系统菜单，Android 使用透明锚定菜单；Web 使用自定义锚定弹窗。平台外观可以遵循各自惯例，但内容和选择规则保持一致。
- **D-10:** 所有窗口跟随 Happy App 当前主题；不得在 iOS 菜单中固定使用深色主题。
- **D-11:** 窄屏 Web 仍使用锚定弹窗；窗口必须限制在视口和安全间距内，空间不足时调整对齐与高度并允许内容滚动。
- **D-12:** 窗口锚定到被点击的控件，优先向上展开；上方空间不足时自动翻转或调整对齐，不改为居中窗口或整行面板。

### 键盘、背景与动画
- **D-13:** 输入键盘打开时，点击任一控件应保持键盘并立即打开窗口；不得先收起键盘或触发输入区重排。
- **D-14:** 窗口打开期间页面背景完全不变；点击关闭层保持透明，不调暗背景、不使用局部或全局模糊。
- **D-15:** Web 窗口使用轻微淡入、小幅上移和缩放的入场动画，目标时长约 180ms；关闭动画约 140ms。移动原生端沿用系统菜单动画。
- **D-16:** 一个窗口打开时不能直接切换到另一个控件窗口；用户必须先手动关闭当前窗口，再打开另一个窗口。

### the agent's Discretion
无额外产品决策委托。具体间距数值、动画缓动、弹窗尺寸上限和测试结构可由研究与计划阶段在满足上述行为约束的前提下确定。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope
- `.planning/ROADMAP.md` — Phase 6 的目标、成功标准与独立阶段边界。
- `.planning/REQUIREMENTS.md` — `APPUI-01`、`APPUI-02`、`APPUI-03` 的需求定义与追踪关系。

No external specs — requirements are fully captured by the phase records and decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/happy-app/sources/components/AgentInput.tsx`：包含 `AgentInputStatusRow`、`openPicker` 状态、当前权限浮层、桌面组合面板，以及模型和思考程度在桌面与紧凑原生端的现有入口，是本阶段的主要集成点。
- `packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx`：通过 SwiftUI `Menu` 提供旧版 iOS 原生菜单生命周期；需要移除当前固定深色主题的行为。
- `packages/happy-app/sources/components/NativeSettingsMenu.android.tsx` 与 `packages/happy-app/sources/components/AnchoredActionMenu.tsx`：提供旧版 Android 透明锚定菜单、视口测量、上下翻转与可滚动高度处理。
- `packages/happy-app/sources/components/anchoredActionMenuPlacement.ts`：已有基于安全区、键盘高度与窗口尺寸的锚定位置计算。
- `packages/happy-app/sources/components/AnimatedOverlay.tsx`：已有淡入、缩放与位移动画参数可供 Web 动效复用，但本阶段不得复用其局部模糊背景。
- `packages/happy-app/sources/-session/SessionView.tsx`：负责模型、权限、思考程度选项及模型切换后的思考程度兼容回退。

### Established Patterns
- 当前紧凑原生布局仅在非 Web、非 Mac 且宽度不超过 700 时启用；窄屏 Web 仍走 Web 自定义弹窗路径，因此必须单独验证视口约束。
- 当前 `openPicker` 保证一次只存在一个自定义选择窗口；本阶段继续保持单窗口约束，并按 D-16 禁止直接切换。
- 当前权限入口会经过键盘关闭协调器，再挂载带 `LocalBlurHalo` 的内联 `FloatingOverlay`；这与旧版无闪烁权限菜单的生命周期不同，是需要移除或绕开的主要问题路径。
- 提交 `42af39305ba5c07ea0359211882756b9f5ffbb49` 移除了紧凑原生操作栏中的旧权限 `NativeSettingsMenu` 入口，并把权限迁移到状态行；规划时应对照该提交父版本的 `AgentInput.tsx`，恢复生命周期而不是恢复旧布局。

### Integration Points
- 在 `AgentInputStatusRow` 中把模型和思考程度控件放到权限控件右侧，同时从桌面及紧凑原生底部动作行移除重复入口。
- 由三个状态行触发控件分别打开权限窗口或模型/思考程度组合窗口，并把触发控件的测量结果传给平台菜单或 Web 锚定弹窗。
- 保留 `SessionView` 已有选项来源和兼容回退，不改变会话协议或模型能力定义。

</code_context>

<specifics>
## Specific Ideas

- 旧权限按钮没有背景闪烁，是本阶段必须对照的体验基准；恢复的是其键盘、透明背景与原生菜单生命周期，不是旧按钮所在的底部布局。
- 新增的模型与思考程度窗口必须从一开始就遵守与权限窗口相同的无闪烁约束，不能在完成权限修复后另建一套背景生命周期。

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 06-chat-composer-controls-and-popover-motion*
*Context gathered: 2026-08-15*
