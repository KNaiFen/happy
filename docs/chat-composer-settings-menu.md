# 聊天 Composer 设置菜单

## 状态

当前实现。本文描述活动会话中 `AgentInput` 的权限、模型和思考程度控件，
不描述首页 `HomeDock` 或历史设置齿轮布局。

## 布局契约

- 三个触发器位于消息输入面板正上方，顺序固定为权限、模型、思考程度。
- 控件保持单行，不换行，也不提供横向滚动。
- 权限和思考程度按完整当前值确定宽度；模型占用剩余宽度并可以收缩。
- 模型触发器保留名称开头和最后六个 Unicode 字符，在中间省略；菜单项和
  无障碍标签始终使用完整名称。
- 触发器只显示当前值。权限使用独立菜单；模型和思考程度使用相同的组合菜单，
  触发器对应分组排在前面。

## 选择与生命周期

- 权限和思考程度选中后关闭菜单；模型选择保持菜单打开，
  以便父级状态更新后立即反映模型和兼容思考程度的选中状态。
- 全局设置菜单协调器一次只允许一个菜单持有打开权。另一个触发器在当前菜单
  完成关闭前只能请求关闭当前菜单，不能直接切换。
- 透明的全屏命中层在菜单退出完成前持续拦截点击，防止点击穿透；它不调暗、
  模糊或重绘页面背景。
- 设置菜单触发器不会调用输入框 `blur`，也不参与 Composer 高度计算。

## 平台实现

- Web：菜单 portal 到 `document.body`，默认向上锚定；空间不足时翻转并限制在
  视口内，内容超高时在菜单内部滚动。打开动画为 180ms，关闭动画为 140ms，
  `prefers-reduced-motion: reduce` 下时长为 0。触发器和菜单项显式输出
  `aria-expanded`、`aria-checked`、`aria-disabled` 和完整标签，并支持 Escape、
  Space、方向键及 Home/End 键盘操作。
- Android：`NativeSettingsMenu.android.tsx` 测量透明触发器，复用
  `AnchoredActionMenu`、安全区和键盘边界计算；原生 Modal 不使用额外 fade。
- iOS：`NativeSettingsMenu.ios.tsx` 使用 SwiftUI 系统 `Menu`，`Host` 的
  `colorScheme` 和 tint 跟随 Happy 当前主题，禁用项使用系统 disabled modifier；
  iOS 16.4+ 通过系统 dismiss behavior 保持模型选择菜单打开。

## 代码与验证入口

- 布局和选项组装：`packages/happy-app/sources/components/AgentInput.tsx`
- 平台菜单：`NativeSettingsMenu.web.tsx`、`NativeSettingsMenu.android.tsx`、
  `NativeSettingsMenu.ios.tsx`
- 锚定与滚动：`AnchoredActionMenu.tsx`、`anchoredActionMenuPlacement.ts`
- 排序、关闭策略和互斥：`settingsMenuPolicy.ts`、`settingsMenuCoordinator.ts`
- 纯逻辑回归测试：`anchoredActionMenu.test.ts`、`settingsMenuPolicy.test.ts`、
  `settingsMenuCoordinator.test.ts`
