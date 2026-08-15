# Phase 06: Chat Composer Controls And Popover Motion - Research

**Researched:** 2026-08-15
**Domain:** React Native/Expo cross-platform composer controls, anchored menus, and popover lifecycle
**Confidence:** HIGH for current-code architecture; MEDIUM for iOS 15.1-16.3 no-dismiss behavior

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### 控件行与窄屏适配
- **D-01:** 权限、模型、思考程度三个控件保持单行，并按照权限、模型、思考程度的顺序从左向右排列；最右侧保留协调间距。
- **D-02:** 权限和思考程度控件保持完整显示；空间不足时由模型控件吸收宽度压缩，不换行、不横向滚动。
- **D-03:** 模型名称采用中间截断，同时保留名称首尾；完整名称在模型窗口中展示，当前模型带选中标记。
- **D-04:** 三个控件平时只显示当前选中值，不增加字段名前缀或额外图标，并沿用当前权限组件的视觉语言。

#### 弹窗内容与选择行为
- **D-05:** 权限控件打开独立权限窗口；模型与思考程度控件打开同一个组合窗口。
- **D-06:** 组合窗口根据触发控件调整内容顺序：点击模型时模型部分优先，点击思考程度时思考程度部分优先，另一部分紧随其后。
- **D-07:** 选择权限或思考程度后立即关闭对应窗口；选择模型后组合窗口保持打开，让用户查看或继续调整思考程度。
- **D-08:** 新模型不支持当前思考程度时，沿用自动回退逻辑切换到受支持的默认程度，并在保持打开的窗口中明确更新选中状态。

#### 跨平台弹窗形态
- **D-09:** 移动原生端复用旧版权限按钮使用的原生菜单生命周期：iOS 使用系统菜单，Android 使用透明锚定菜单；Web 使用自定义锚定弹窗。平台外观可以遵循各自惯例，但内容和选择规则保持一致。
- **D-10:** 所有窗口跟随 Happy App 当前主题；不得在 iOS 菜单中固定使用深色主题。
- **D-11:** 窄屏 Web 仍使用锚定弹窗；窗口必须限制在视口和安全间距内，空间不足时调整对齐与高度并允许内容滚动。
- **D-12:** 窗口锚定到被点击的控件，优先向上展开；上方空间不足时自动翻转或调整对齐，不改为居中窗口或整行面板。

#### 键盘、背景与动画
- **D-13:** 输入键盘打开时，点击任一控件应保持键盘并立即打开窗口；不得先收起键盘或触发输入区重排。
- **D-14:** 窗口打开期间页面背景完全不变；点击关闭层保持透明，不调暗背景、不使用局部或全局模糊。
- **D-15:** Web 窗口使用轻微淡入、小幅上移和缩放的入场动画，目标时长约 180ms；关闭动画约 140ms。移动原生端沿用系统菜单动画。
- **D-16:** 一个窗口打开时不能直接切换到另一个控件窗口；用户必须先手动关闭当前窗口，再打开另一个窗口。

### the agent's Discretion
无额外产品决策委托。具体间距数值、动画缓动、弹窗尺寸上限和测试结构可由研究与计划阶段在满足上述行为约束的前提下确定。

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| APPUI-01 | Happy App 聊天页在消息发送框上方依次展示权限、模型和思考程度组件，模型与思考程度位于权限组件右侧，并在最右侧保留协调间距 | Put all three triggers in `AgentInputStatusRow`, make only the model slot shrinkable, and remove the desktop/compact-native duplicates from the composer action row. [VERIFIED: .planning/REQUIREMENTS.md:46; packages/happy-app/sources/components/AgentInput.tsx:517-624,1238-1307,1835-1847,1913-1997] |
| APPUI-02 | 权限窗口打开和关闭时不发生背景闪烁，并使用从旧权限按钮实现验证或恢复的平滑动画生命周期 | Restore the old direct `NativeSettingsMenu` lifecycle at the new status-row location; do not route permission through `openPicker`, input blur, or `FloatingOverlay`. [VERIFIED: git 42af39305ba5c07ea0359211882756b9f5ffbb49^:packages/happy-app/sources/components/AgentInput.tsx:1035-1050,1904-1916; packages/happy-app/sources/components/AgentInput.tsx:1002-1048] |
| APPUI-03 | 模型和思考程度窗口复用同一无闪烁动画模式，在 Happy App 支持的聊天页面尺寸下不重叠、不溢出 | Use the same platform menu seam for both triggers, order the shared groups by trigger, and reuse the safe-area/keyboard-aware placement helper for Android and Web. [VERIFIED: .planning/REQUIREMENTS.md:48; packages/happy-app/sources/components/NativeSettingsMenu.tsx:4-35; packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:1-108] |
</phase_requirements>

## Summary

Phase 6 is a UI integration/refactor, not a new session capability. `SessionView` already derives permission, model, and effort options, passes them into `ChatComposer`, and performs model-to-effort fallback atomically through `sessionSetAgentModes`; preserve that ownership and change only the composer presentation seam. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:743-781,875-893,1141-1154]

The current regression is structural: permission is now a status-row `Pressable`, while model and effort remain duplicated in desktop and compact-native composer action rows; permission/model/effort custom overlays still use `openPicker`, and that path calls the keyboard coordinator with `inputRef.current?.blur()`. The exact current picker union is `type ComposerPicker = 'permission' | 'model' | 'effort' | 'context';`. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1002-1048,1238-1307,1835-1847,1913-1997]

**Primary recommendation:** Make `NativeSettingsMenu` the single platform seam for all three status-row triggers, extend its option contract with per-selection dismissal, implement the Web variant as a real anchored transparent popover, and retain `openPicker` only for the unrelated context-usage surface. [ASSUMED]

The highest-risk item is iOS compatibility. Expo SDK 55 supports iOS `15.1+`, but `menuActionDismissBehavior` is only supported on iOS `16.4+`; the installed Expo UI Swift implementation returns the content unchanged below that OS version. A Wave 0 device/simulator spike must verify whether rendering the model group as a SwiftUI `Picker` keeps the system menu open on iOS 15.1-16.3; if it does not, D-07 and D-09 cannot both be met on that OS range without a product/support-boundary decision. [CITED: https://docs.expo.dev/versions/v55.0.0/; https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior] [VERIFIED: packages/happy-app/node_modules/@expo/ui/ios/Modifiers/ViewModifierRegistry.swift:426-447]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Composer control row layout | Browser / Client | Native UI host | React Native owns the shared row; platform wrappers only own trigger presentation. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:505-624,1835-1847] |
| Permission window | Browser / Client | Native UI host | `AgentInput` builds current option data; iOS and Android own their presentation lifecycle. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.tsx:4-35] |
| Model/effort combined window | Browser / Client | Native UI host | Shared group ordering/dismissal policy belongs in TypeScript; iOS system `Menu`, Android anchored modal, and Web custom popover render it. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-70; packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:12-65] |
| Web anchoring and motion | Browser / Client | CDN / Static | Anchor measurement, viewport clamping, and Reanimated surface motion are client-only; no server behavior changes. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:18-108; packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41] |
| Model capability/effort fallback | Browser / Client | API / Backend | `SessionView` remains the client owner of option derivation and sends the existing session-mode mutation; this phase must not change the protocol. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:743-781,875-893] |
| Persisted session mode | API / Backend | Database / Storage | The UI continues to call the existing `sessionSetAgentModes`; no schema or stored-value migration is required. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:875-893] |

## Project Constraints (from AGENTS.md)

- Read the nearest `AGENTS.md`, keep changes scoped/reviewable, update local `.agents` durable memory when project state changes, verify the smallest relevant surface, and use a short Chinese commit subject. [VERIFIED: AGENTS.md:3-11]
- Never increment minor/major versions without an explicit request and never reuse a version after its release workflow has run; Phase 6 changes distributable App behavior, so implementation must advance only the affected App patch version. [VERIFIED: AGENTS.md:8-11,59-68]
- Preserve the Codex-only, explicit `flavor=codex`/`codexSyncVersion=4`, stable-v2, official-RPC, official-summary-only, authoritative-lifecycle, and child-thread isolation boundaries. This UI phase must not add prompt fallbacks or alter protocol/lifecycle state. [VERIFIED: AGENTS.md:13-21]
- Preserve durable Sync v4 queues/ACK/cursors/polling/journal/snapshots and payload-free operational logging; no prompt, reasoning, tool payload, provider ID, token, key, or signing material may be logged. [VERIFIED: AGENTS.md:23-27]
- Browser Web remains HTTPS/localhost; native insecure HTTP remains gated by explicit trusted-network opt-in. [VERIFIED: AGENTS.md:23-27]
- Keep `AGENTS.md`, nested instruction files, `.agents/`, `.codex/`, `.gemini/`, and `.mcp.json` local-only; never stage them and never create `CLAUDE.md`, `CLAUDE.local.md`, or `.claude/`. [VERIFIED: AGENTS.md:29-34]
- Treat generated documentation indexes as generated, keep only active plans under `docs/plans/`, and run docs synchronization/checking after Markdown or package-version changes. [VERIFIED: AGENTS.md:36-51]
- Push project work only to `origin`; `upstream` is fetch-only. [VERIFIED: AGENTS.md:53-57]
- Normal App/Web/Android/Tauri/Docker/release builds run in GitHub Actions. Local verification must remain source-only (`tsc --noEmit`, direct Vitest/tsx, or a development server); do not build release artifacts or official Codex locally. [VERIFIED: AGENTS.md:59-69,81-87]
- Preserve `node_modules`, caches, SDKs, and generated ignored development state; do not clean routine local dependencies. [VERIFIED: AGENTS.md:81-87]
- Do not run local Cargo/Tauri compilation unless explicitly requested, and do not use it as routine App/Web verification. [VERIFIED: AGENTS.md:89-93]
- A successful Android release must preserve production package `com.ex3ndr.happy`, ARM64-only output, SDK 36, OTA-disabled state, derived versionCode, certificate, and 16 KB alignment checks; by default provide the verified artifact URL rather than downloading the APK. [VERIFIED: AGENTS.md:72-79,95-100]
- Debian Relay and CLI release/deployment rules remain out of Phase 6 scope and must not be touched. [VERIFIED: AGENTS.md:59-78,102-106]
- The special `sync to main` workflow is fetch/rebase-or-fast-forward/normal-push only; never force-push. [VERIFIED: AGENTS.md:108-118]

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard Here |
|---------|---------|---------|-------------------|
| React Native | exact `"react-native": "0.83.1"` | Shared control row, `Pressable`, `Modal`, `Text`, `measureInWindow` | Already owns the App UI and exposes the required platform primitives. [VERIFIED: packages/happy-app/package.json:164-179] |
| Expo / Expo UI | `"expo": "~55.0.8"`, `"@expo/ui": "~55.0.5"` | iOS SwiftUI `Host`/`Menu` and native platform integration | The old stable permission lifecycle already uses this seam; Expo UI exposes `Host.colorScheme` and menu dismissal modifiers. [VERIFIED: packages/happy-app/package.json:65,101; packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:1-70] [CITED: https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/menu/] |
| React Native Reanimated | `"react-native-reanimated": "^4.2.3"` | Web popover entering/exiting motion with reduced-motion support | Existing `AnimatedOverlay` already uses layout animation builders and `ReduceMotion.System`. [VERIFIED: packages/happy-app/package.json:178; packages/happy-app/sources/components/AnimatedOverlay.tsx:5-41] |
| React Native Unistyles | `"react-native-unistyles": "~3.1.1"` | Theme-derived colors and current dark/light state | Existing composer/menu surfaces use `useUnistyles`; the iOS host should derive its scheme from the same theme rather than hard-code dark. [VERIFIED: packages/happy-app/package.json:184; packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-30] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `react-native-safe-area-context` | `"~5.7.0"` | Viewport-safe menu bounds | Feed current safe-area insets into anchored placement. [VERIFIED: packages/happy-app/package.json:179; packages/happy-app/sources/components/AnchoredActionMenu.tsx:5,37-53] |
| `react-native-keyboard-controller` | `"~1.21.1"` | Read visible keyboard height for placement | Use only for bounds; do not dismiss the keyboard for composer controls. [VERIFIED: packages/happy-app/package.json:171; packages/happy-app/sources/components/AnchoredActionMenu.tsx:4,39-53] |
| Vitest | declared `"^3.2.6"`, installed `3.2.7` | Pure state/placement regression tests | Existing config discovers `.test.ts`/`.spec.ts` under `sources`. [VERIFIED: packages/happy-app/package.json:201-214; packages/happy-app/vitest.config.ts:4-24] [VERIFIED: local `vitest --version`, 2026-08-15] |
| TypeScript | exact `"5.9.3"` | Cross-platform prop and platform-file contract validation | Use the existing App typecheck; no build is required. [VERIFIED: packages/happy-app/package.json:201-214] |

### Registry Version Verification

The exact existing baseline versions queried from npm on 2026-08-15 were published as follows; these checks establish that the repository constraints resolve to real registry versions, not that Phase 6 should upgrade them. [VERIFIED: local `npm view <package>@<version> version time --json`, 2026-08-15]

| Package | Queried Version | Published (UTC) | Source |
|---------|-----------------|-----------------|--------|
| `react-native` | `0.83.1` | `2025-12-18T14:51:47.747Z` | [CITED: https://registry.npmjs.org/react-native] |
| `expo` | `55.0.8` | `2026-03-19T00:02:56.622Z` | [CITED: https://registry.npmjs.org/expo] |
| `@expo/ui` | `55.0.5` | `2026-03-19T09:08:27.397Z` | [CITED: https://registry.npmjs.org/@expo%2fui] |
| `react-native-reanimated` | `4.2.3` | `2026-03-20T13:15:43.163Z` | [CITED: https://registry.npmjs.org/react-native-reanimated] |
| `react-native-unistyles` | `3.1.1` | `2026-03-10T12:02:56.516Z` | [CITED: https://registry.npmjs.org/react-native-unistyles] |
| `react-native-safe-area-context` | `5.7.0` | `2026-02-24T20:53:59.356Z` | [CITED: https://registry.npmjs.org/react-native-safe-area-context] |
| `react-native-keyboard-controller` | `1.21.1` | `2026-03-20T10:45:37.616Z` | [CITED: https://registry.npmjs.org/react-native-keyboard-controller] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Extend the existing `NativeSettingsMenu` platform seam | Restore the deleted `SessionStatusBar` | Rejected: it would reintroduce unrelated branch/usage-limit UI, separate menu state, icons, fixed-right positioning, and local blur. [VERIFIED: git 42af39305ba5c07ea0359211882756b9f5ffbb49^:packages/happy-app/sources/components/SessionStatusBar.tsx:24-218,400-490] |
| Shared placement helper plus platform renderer | Keep the current whole-composer `FloatingOverlay` | Rejected: it is not anchored to the clicked control; native `FloatingOverlay` adds `LocalBlurHalo`, and current picker opening blurs/dismisses the keyboard. [VERIFIED: packages/happy-app/sources/components/FloatingOverlay.tsx:35-81; packages/happy-app/sources/components/AgentInput.tsx:1014-1027,1455-1551] |
| Existing in-repo stack | Add a popover/menu dependency | Rejected: placement, native menu presentation, animation, safe area, and tests already exist in-repo; a new package adds supply-chain and platform risk without closing a missing capability. [VERIFIED: packages/happy-app/sources/components/AnchoredActionMenu.tsx:28-153; packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41] |

**Installation:** No dependency installation is required. [VERIFIED: packages/happy-app/package.json:47-214]

## Package Legitimacy Audit

This phase installs no external package, so the Package Legitimacy Gate is not triggered. Existing package names and version constraints come from the checked-in App manifest and official Expo/React Native documentation. [VERIFIED: packages/happy-app/package.json:47-214]

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```text
SessionView existing option derivation
  permissionMode / availableModes
  modelMode / availableModels
  effortLevel / availableEffortLevels
  updateModelMode -> existing incompatible-effort fallback
                         |
                         v
AgentInputStatusRow (one non-wrapping row)
  [permission, fixed] [model, shrink + middle ellipsis] [effort, fixed] [trailing gap]
       |                         |                           |
       | permission groups       | model-first groups        | effort-first groups
       +-------------------------+---------------------------+
                                 |
                                 v
                    NativeSettingsMenu contract
                group order + selected key + dismiss policy
                   /                |                 \
                  v                 v                  v
      iOS SwiftUI Host/Menu   Android transparent    Web custom anchored
      dynamic colorScheme     AnchoredActionMenu     transparent portal/layer
      model no-dismiss        measureInWindow        measureInWindow
      system motion           safe-area/keyboard     safe-area/viewport clamp
                  \                 |                  /
                   +----------------+-----------------+
                                    |
                                    v
                    existing on*ModeChange callbacks
                                    |
                                    v
                 sessionSetAgentModes (no protocol change)
```

The entry points, branch policy, and downstream mutation shown above are all present today except the proposed unified menu contract/Web implementation. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:48-65,1002-1143; packages/happy-app/sources/-session/SessionView.tsx:875-893,1141-1154] [ASSUMED]

### Component Responsibilities

| Component/File | Responsibility in Phase 6 |
|----------------|---------------------------|
| `AgentInput.tsx` | Own row layout, current labels, ordered menu groups, trigger anchoring, and removal of duplicate action-row controls. Preserve context picker behavior separately. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:505-624,1002-1158,1238-1307,1835-1847,1913-1997] |
| `NativeSettingsMenu.tsx` | Add a platform-neutral per-option/per-group close policy while preserving the current group/selection contract. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.tsx:4-35] [ASSUMED] |
| `NativeSettingsMenu.ios.tsx` | Derive `Host.colorScheme` from the Happy theme, remove fixed white tint, render model actions with no-dismiss semantics, and keep permission/effort dismissing. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-68] [ASSUMED] |
| `NativeSettingsMenu.android.tsx` | Keep old transparent measured-anchor lifecycle and close only when the selected option policy requires it. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:20-63] [ASSUMED] |
| `NativeSettingsMenu.web.tsx` | Replace the current no-op wrapper with measured trigger, grouped selectable content, Escape/click-away close, and Web-only surface motion. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.web.tsx:1-7] [ASSUMED] |
| `AnchoredActionMenu.tsx` / `anchoredActionMenuPlacement.ts` | Reuse transparent modal/backdrop, safe-area and keyboard bounds; add a caller-selected above-first preference without changing the default used by queued-message menus. [VERIFIED: packages/happy-app/sources/components/AnchoredActionMenu.tsx:28-153; packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:18-108] [ASSUMED] |
| `AnimatedOverlay.tsx` or a small Web popover surface component | Reuse cubic timing, scale/translate initial values, and reduced-motion handling without `LocalBlurHalo`; use 180ms enter and 140ms exit only for this popover. [VERIFIED: packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41,135-223] [ASSUMED] |
| `SessionView.tsx` | No behavioral rewrite; retain option source and fallback. Add tests only if extracting a pure helper is necessary. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:743-781,875-893] |

### Recommended Project Structure

```text
packages/happy-app/sources/components/
├── AgentInput.tsx                         # row integration and menu group order
├── NativeSettingsMenu.tsx                 # shared group/option/dismiss contract
├── NativeSettingsMenu.ios.tsx             # SwiftUI system menu + dynamic theme
├── NativeSettingsMenu.android.tsx         # transparent anchored native menu
├── NativeSettingsMenu.web.tsx             # custom anchored Web popover
├── AnchoredActionMenu.tsx                  # reusable transparent anchored frame/list
├── anchoredActionMenuPlacement.ts          # pure viewport placement
├── anchoredActionMenu.test.ts              # placement preference/bounds tests
├── composerControlMenu.ts                  # optional pure ordering/dismiss helpers
└── composerControlMenu.test.ts             # APPUI-01/03 behavior tests
```

The existing files in this structure are verified; the two `composerControlMenu.*` files are recommended Wave 0 additions only if keeping the ordering policy inside `AgentInput.tsx` would make it untestable. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx; packages/happy-app/sources/components/NativeSettingsMenu.tsx; packages/happy-app/sources/components/anchoredActionMenuPlacement.ts] [ASSUMED]

### Pattern 1: Platform Seam, Shared Behavioral Contract

**What:** Build the option groups once, but pass different order for the model and effort triggers. Put close behavior on the selected option/group, not in each renderer. [ASSUMED]

**When to use:** Permission receives one group; model receives `[model, effort]`; effort receives `[effort, model]`. The exact existing group keys are quoted as `key: 'model'` and `key: 'effort'`. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1107-1143]

### Pattern 2: Anchor Measurement Plus Pure Placement

**What:** Measure the clicked trigger with `measureInWindow`, then call the existing pure placement helper with viewport, safe area, keyboard height, desired menu size, and an above-first preference scoped to settings menus. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:20-29; packages/happy-app/sources/components/AnchoredActionMenu.tsx:37-53] [ASSUMED]

**When to use:** Android and Web settings menus. Do not globally reverse the current helper's default order because `AnchoredActionMenu` has other callers. [VERIFIED: packages/happy-app/sources/components/AnchoredActionMenu.tsx:28-153; CodeGraph blast-radius query, 2026-08-15]

### Pattern 3: Stable Transparent Layer, Animated Surface Only

**What:** Keep a transparent click-away layer mounted while the surface exits; animate only opacity/translate/scale of the surface. Set the enclosing Web modal/portal animation to none so the page background never fades. [CITED: https://reactnative.dev/docs/modal; https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/] [ASSUMED]

**When to use:** Web custom popover. The current Reanimated preset already uses cubic easing, `scale: 0.96`, `translateY: 8`, and 140ms exit; make a popover-specific 180ms enter instead of changing every `AnimatedPopup` caller. [VERIFIED: packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41]

### Pattern 4: Preserve Focus Instead of Coordinating Dismissal

**What:** Settings triggers must bypass `KeyboardDismissCoordinator`; Web must prevent trigger focus transfer or immediately preserve the composer `MultiTextInputHandle.focus()` without an intervening layout change. The handle exposes `focus` and `blur` verbatim: `focus: () => void; blur: () => void;`. [VERIFIED: packages/happy-app/sources/components/MultiTextInput.tsx:26-31] [ASSUMED]

**When to use:** Permission, model, and effort only. The context-usage picker can retain its current behavior because it is outside the phase boundary. [VERIFIED: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:6-10]

### Anti-Patterns to Avoid

- **Restoring old layout:** Restore the old menu lifecycle, not the removed bottom-row permission gear. [VERIFIED: git 42af39305ba5c07ea0359211882756b9f5ffbb49^:packages/happy-app/sources/components/AgentInput.tsx:1904-1916]
- **One full-width composer overlay:** It cannot satisfy per-trigger anchoring and narrow viewport rules. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1455-1551]
- **Changing shared placement defaults globally:** Queued-message action menus also consume `AnchoredActionMenu`; add an explicit preference for settings callers. [VERIFIED: CodeGraph blast-radius query, 2026-08-15]
- **Local blur or dim overlay:** `LocalBlurHalo` and any non-transparent backdrop directly violate D-14. [VERIFIED: packages/happy-app/sources/components/FloatingOverlay.tsx:61-80; .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:34-38]
- **Independent model and effort popup state:** Both triggers must open the same combined content with only the section order changed. [VERIFIED: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:22-27]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Viewport/safe-area/keyboard positioning | New arithmetic in `AgentInput` | `resolveAnchoredMenuPlacement` | It already clamps width/height and accounts for safe area plus keyboard. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:36-108] |
| iOS system menu | Custom iOS popover | Expo UI SwiftUI `Host` + `Menu` | D-09 locks the system menu lifecycle and the old permission implementation already uses it. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-70] |
| Animation engine/timers | `setTimeout`-driven opacity/scale | Reanimated entering/exiting builders with `ReduceMotion.System` | Existing App code and official docs cover timing, easing, initial values, and reduced motion. [VERIFIED: packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41] [CITED: https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/] |
| Model-effort compatibility | New fallback in menu code | Existing `SessionView.updateModelMode` | It already sends model plus fallback effort in one mutation. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:880-889] |
| Keyboard dismissal sequencing | Another coordinator or delay | Direct native menu lifecycle and focus preservation | D-13 requires no dismissal; current coordinator explicitly blurs/dismisses and waits. [VERIFIED: packages/happy-app/sources/utils/keyboardDismissCoordinator.ts:28-63] |
| New menu dependency | Third-party popover package | Existing platform files, placement helper, Reanimated, and Unistyles | All required primitives are already present and source-tested. [VERIFIED: packages/happy-app/package.json:47-214] |

**Key insight:** The hard part is lifecycle coordination, not drawing the menu. Reuse the already stable platform boundary and make visibility/dismissal explicit rather than layering another overlay path into `AgentInput`. [VERIFIED: git e558f8a1337490adf941466bd56b838d85b83808; git 42af39305ba5c07ea0359211882756b9f5ffbb49]

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Existing session fields `permissionMode`, `modelMode`, and `effortLevel` remain the only stored selections; no value or schema is renamed. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:755-781,875-893] | Code edit only; no data migration. |
| Live service config | None identified; menu visibility/order/theme live entirely in App source and are not server/UI-managed configuration. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:48-65,1002-1143] | None. |
| OS-registered state | None identified; no task, service, deep-link, permission, or OS registration changes. [VERIFIED: packages/happy-app/app.config.js:79-246] | None. |
| Secrets/env vars | None identified; the phase reads no new environment variable or secret. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1-65; packages/happy-app/sources/components/NativeSettingsMenu.tsx:1-35] | None. |
| Build artifacts / installed packages | The App bundle must be regenerated by the normal cloud workflow after the required patch version bump; no local package/install artifact is changed. [VERIFIED: AGENTS.md:59-69,81-93; packages/happy-app/package.json:2-24] | Cloud build/release verification only; preserve local caches and installed dependencies. |

## Common Pitfalls

### Pitfall 1: Reusing the Wrong Part of the Old Implementation
**What goes wrong:** The bottom action-row permission button returns, violating APPUI-01 and duplicating the new status-row control.
**Why it happens:** Commit `42af393...` removed both the old trigger location and its stable native wrapper in one change. [VERIFIED: git show 42af39305ba5c07ea0359211882756b9f5ffbb49]
**How to avoid:** Restore only `permissionSettingsGroups` plus direct platform-menu wrapping at the status-row trigger.
**Warning signs:** `agent-input-permission-menu` appears in both the status row and compact action row.

### Pitfall 2: Keyboard Still Blurs on Web or Native
**What goes wrong:** The keyboard closes, composer height changes, and the anchor moves before the menu appears.
**Why it happens:** Current `handlePickerPress` passes `() => inputRef.current?.blur()`; the coordinator calls blur even on immediate Web execution and dismisses native keyboards when visible. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1014-1027; packages/happy-app/sources/utils/keyboardDismissCoordinator.ts:40-63]
**How to avoid:** Do not call this path for the three controls; preserve the input focus on Web.
**Warning signs:** `Keyboard.dismiss`, `inputRef.current?.blur()`, 420ms fallback, or input-area movement appears in a control-open path.

### Pitfall 3: Model Selection Closes the Combined Window
**What goes wrong:** D-07/D-08 cannot be observed because the menu disappears before the effort fallback updates.
**Why it happens:** Android currently calls `closeMenu()` before every `group.onSelect`, and current desktop/compact overlays call `closePicker()` after model selection. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:30-41; packages/happy-app/sources/components/AgentInput.tsx:1494-1503,1681-1691]
**How to avoid:** Add per-selection dismissal and use Expo's menu dismiss modifier/Picker strategy on iOS.
**Warning signs:** Dismissal is hard-coded in a renderer rather than carried by menu data.

### Pitfall 4: iOS 15.1-16.3 Ignores No-Dismiss Modifier
**What goes wrong:** The implementation passes current-device testing but violates D-07 on older supported iOS.
**Why it happens:** Expo SDK 55 supports `15.1+`, while `menuActionDismissBehavior` is `iOS 16.4+`; the installed modifier's fallback is simply `content`. [CITED: https://docs.expo.dev/versions/v55.0.0/; https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior] [VERIFIED: packages/happy-app/node_modules/@expo/ui/ios/Modifiers/ViewModifierRegistry.swift:435-447]
**How to avoid:** Wave 0 must test a `Picker`-based model group on an older supported iOS runtime before the full refactor.
**Warning signs:** Only iOS 16.4+ or current iOS is tested.

### Pitfall 5: Global Above-First Change Regresses Other Menus
**What goes wrong:** Queued-message action menus flip direction unexpectedly.
**Why it happens:** The placement helper currently hard-codes candidate order beginning with below/end, and `AnchoredActionMenu` has callers outside settings. The exact current direction union is `direction: 'above' | 'below'`. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:8-16,59-69; CodeGraph blast-radius query, 2026-08-15]
**How to avoid:** Add a caller-provided preference with current behavior as default; settings pass above-first.
**Warning signs:** Existing test “opens below” changes without a caller-specific test.

### Pitfall 6: Exit Motion Is Unmounted With the Modal
**What goes wrong:** Opening animates but closing snaps, or a transparent modal lingers and blocks clicks.
**Why it happens:** Reanimated exiting children cannot complete if their non-animated parent is removed immediately; official docs also warn about view flattening and recommend a stable/non-collapsible parent where required. [CITED: https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/]
**How to avoid:** Use a small visible/closing state machine, retain the last anchor during 140ms exit, and unmount the transparent portal only after the exit callback. [ASSUMED]
**Warning signs:** `return null` occurs as soon as public `visible` becomes false.

### Pitfall 7: Theme Is Still Hard-Coded
**What goes wrong:** iOS menu remains dark in light theme or uses white tint on a light system surface.
**Why it happens:** Current source says `<Host colorScheme="dark">` and `tint('#FFFFFF')`. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-55]
**How to avoid:** Derive `light`/`dark` from the current Unistyles theme and remove fixed white tint.
**Warning signs:** Literal `dark` or `#FFFFFF` remains in the iOS menu renderer.

### Pitfall 8: Flex Rules Truncate the Wrong Controls
**What goes wrong:** Permission/effort ellipsize or the row wraps while the model retains width.
**Why it happens:** Generic `flexShrink: 1` on every chip shares shrinkage. The deleted status bar did exactly that for all chips. [VERIFIED: git 42af39305ba5c07ea0359211882756b9f5ffbb49^:packages/happy-app/sources/components/SessionStatusBar.tsx:405-433]
**How to avoid:** Permission and effort use `flexShrink: 0`; the model wrapper uses `flex: 1`, `minWidth: 0`, and its text uses `numberOfLines={1}` plus `ellipsizeMode="middle"`. [CITED: https://reactnative.dev/docs/text#ellipsizemode]
**Warning signs:** More than one control has shrink enabled or the model uses current `ellipsizeMode="head"`. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1145-1156,1287]

### Pitfall 9: Tests Are Added but Never Discovered
**What goes wrong:** Component tests appear green because Vitest did not include them.
**Why it happens:** Current include is exactly `include: ['sources/**/*.{spec,test}.ts']`, which excludes `.tsx`. [VERIFIED: packages/happy-app/vitest.config.ts:4-9]
**How to avoid:** Keep new policy/placement tests in pure `.test.ts` helpers, or intentionally update config and prove `.tsx` discovery.
**Warning signs:** A new `.test.tsx` file is absent from verbose Vitest output.

## Code Examples

Verified patterns from current source and official documentation:

### Preserve Existing Model/Effort Fallback

```typescript
// Source: packages/happy-app/sources/-session/SessionView.tsx:880-889
const updateModelMode = React.useCallback((mode: ModelMode) => {
    const nextEffortLevels = getEffortLevelsForModel(flavor, mode.key, session.metadata);
    const currentEffortSupported = session.effortLevel
        ? nextEffortLevels.some((level) => level.key === session.effortLevel)
        : true;
    sessionSetAgentModes(sessionId, {
        modelMode: mode.key,
        ...(!currentEffortSupported ? { effortLevel: mode.defaultThinkingLevel ?? null } : {}),
    });
}, [sessionId, flavor, session.metadata, session.effortLevel]);
```

The menu should observe the resulting props; do not copy this mutation logic into `AgentInput`. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:880-889]

### iOS Model Action That Does Not Dismiss

```tsx
// Sources:
// https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior
// packages/happy-app/node_modules/@expo/ui/src/swift-ui/modifiers/index.ts:629-637
<Button
    modifiers={[menuActionDismissBehavior('disabled')]}
    label={option.label}
    onPress={() => group.onSelect(option.key)}
/>
```

Use `menuActionDismissBehavior('enabled')` for permission/effort actions. Below iOS 16.4, verify a `Picker` model group because the modifier is unavailable. [CITED: https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior] [ASSUMED]

### Popover Motion Baseline

```typescript
// Existing pattern: packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41
// Locked duration: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:34-38
const composerPopoverEntering = FadeIn
    .duration(180)
    .easing(Easing.out(Easing.cubic))
    .withInitialValues({
        opacity: 0,
        transform: [{ scale: 0.96 }, { translateY: 8 }],
    })
    .reduceMotion(ReduceMotion.System);

const composerPopoverExiting = FadeOut
    .duration(140)
    .easing(Easing.in(Easing.cubic))
    .reduceMotion(ReduceMotion.System);
```

This should animate only the Web surface, never the transparent backdrop or page background. [VERIFIED: packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41; .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:34-38]

### Existing Window-Coordinate Measurement

```tsx
// Source: packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:20-29
const triggerRef = React.useRef<View>(null);
const openMenu = React.useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
        if (width <= 0 || height <= 0) return;
        setAnchor({ x, y, width, height });
    });
}, []);
```

React Native documents these callback values as window-relative `x`, `y`, `width`, and `height`. [CITED: https://reactnative.dev/docs/the-new-architecture/layout-measurements#measureinwindowcallback]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact for Phase 6 |
|--------------|------------------|--------------|--------------------|
| Compact-native permission gear directly wrapped by `NativeSettingsMenu` | Permission value moved to `AgentInputStatusRow` and opens the shared custom picker path | Commit `42af39305ba5c07ea0359211882756b9f5ffbb49` on 2026-08-15 | Recover direct platform lifecycle at the new location; do not recover old placement. [VERIFIED: git show 42af39305ba5c07ea0359211882756b9f5ffbb49] |
| Android Expo UI `DropdownMenu` | Measured transparent `AnchoredActionMenu` | Commit `e558f8a1337490adf941466bd56b838d85b83808` on 2026-08-09 | Keep the current transparent Android implementation and extend dismissal policy. [VERIFIED: git show e558f8a1337490adf941466bd56b838d85b83808] |
| Deleted `SessionStatusBar` model/effort chips with fixed-position Web popup and native blur halo | Model/effort controls live in composer action rows | Commit `42af39305ba5c07ea0359211882756b9f5ffbb49` | Reuse only useful flex/selection ideas; do not restore the component. [VERIFIED: git 42af39305ba5c07ea0359211882756b9f5ffbb49^:packages/happy-app/sources/components/SessionStatusBar.tsx:79-218,400-490] |
| Generic Web `FloatingOverlay` intentionally had no entry motion | Phase decision requires dedicated 180/140ms Web popover motion | D-15, 2026-08-15 | Add a composer-popover motion variant; do not change every existing popup caller. [VERIFIED: packages/happy-app/sources/components/FloatingOverlay.tsx:45-58; .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:34-38] |

**Deprecated/outdated for this phase:**
- `SessionStatusBar.tsx`: deleted historical evidence only, not an implementation target. [VERIFIED: git show --stat 42af39305ba5c07ea0359211882756b9f5ffbb49]
- Permission/model/effort values in `desktopActionControls` and the compact action row: remove after status-row integration to prevent duplicate entry points. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1238-1307,1913-1997]
- `Host colorScheme="dark"` plus white tint: incompatible with D-10. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.ios.tsx:24-55]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Add a `dismissOnSelect?: boolean`-style field to the existing option/group contract; the exact API name is an implementation recommendation, not an existing value. | Architecture Patterns | Low: rename during planning without changing behavior. |
| A2 | A model group rendered as SwiftUI `Picker`, backed by `menuActionDismissBehavior('disabled')` on iOS 16.4+, will remain open and refresh selected model/effort state across the full supported iOS range. | Summary / Pitfall 4 | High: must be proven on iOS 15.1-16.3 before claiming D-07/D-08 complete. |
| A3 | A Web combination surface width around 320px, existing 8px viewport margin/6px anchor gap, and 400px maximum desired height will fit the current content while clamping on narrow viewports. | Architecture Patterns | Medium: verify with longest real model/permission labels and all supported viewport sizes. |
| A4 | Preserving input focus on Web can be achieved without a visible refocus/layout flash through the platform trigger implementation. | Pattern 4 | Medium: needs browser focus/virtual-keyboard verification. |
| A5 | A separate pure `composerControlMenu.ts` helper is the smallest way to test ordering and dismissal policy under the current `.test.ts`-only Vitest discovery. | Recommended Project Structure | Low: logic may remain in an existing pure module if equally testable. |

## Open Questions

1. **Does the iOS system menu remain open and live-update selection on iOS 15.1-16.3?**
   - What we know: Expo SDK 55 supports iOS `15.1+`; `menuActionDismissBehavior` begins at `16.4+`; `Menu` accepts `Picker` children. [CITED: https://docs.expo.dev/versions/v55.0.0/; https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/menu/; https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior]
   - What's unclear: Expo/SwiftUI documentation does not guarantee the older-OS Picker dismissal and live-update behavior. [ASSUMED]
   - Recommendation: Make this the first implementation checkpoint. Test model selection plus automatic effort fallback on iOS 15.1-16.3 and 16.4+; if the older range cannot satisfy both D-07 and D-09, stop and request a support/product decision instead of silently violating one. [ASSUMED]

2. **What exact Web width/height cap fits the longest production option data?**
   - What we know: current anchored menus use width `224`, item height `44`, margin `8`, and gap `6`; the current composer overlay max height is `400`. [VERIFIED: packages/happy-app/sources/components/AnchoredActionMenu.tsx:15-16,41-53; packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:36-38; packages/happy-app/sources/components/AgentInput.tsx:1464,1597]
   - What's unclear: model descriptions and localized permission labels can make a combined grouped surface taller/wider than the old flat Android menu. [ASSUMED]
   - Recommendation: Start at 320px desired Web width and 400px desired height, clamp through the placement helper, and verify at 320/375/700/701/1024px widths in light/dark themes. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Typecheck/tests/docs scripts | Yes | `v26.5.1` | None needed. [VERIFIED: local CLI, 2026-08-15] |
| App-local TypeScript | Source typecheck | Yes | `5.9.3` | Run `packages/happy-app/node_modules/.bin/tsc` directly. [VERIFIED: local CLI, 2026-08-15] |
| App-local Vitest | Pure tests | Yes | `3.2.7` | Run `packages/happy-app/node_modules/.bin/vitest` directly. [VERIFIED: local CLI, 2026-08-15] |
| App-local Expo CLI | Web dev surface | Yes | `55.0.18` | Use only a development server; no local release build. [VERIFIED: local CLI, 2026-08-15] |
| `pnpm` | Preferred project wrapper commands | No in current PATH | Declared `pnpm@10.11.0` | Use direct local bins and `node scripts/docs/knowledge-base.mjs`; restore pnpm PATH before any workflow that requires filters. [VERIFIED: packages/happy-app/package.json:217; local CLI, 2026-08-15] |
| Xcode command-line tools | Optional iOS simulator smoke | Yes (`/usr/bin/xcrun`) | Not probed by compilation | Use an existing dev client/simulator only; do not start an unrequested local native build. [VERIFIED: local CLI, 2026-08-15; AGENTS.md:59-69] |
| Android `adb` | Optional device smoke | No in current PATH | — | Use an existing remote/cloud device workflow or human device checkpoint. [VERIFIED: local CLI, 2026-08-15] |
| `agent-browser` | Automated real-browser visual QA | No in current PATH | — | Use the standard browser manually against the Expo Web dev server or install only with explicit authorization. [VERIFIED: local CLI, 2026-08-15] |

**Missing dependencies with no fallback:** none for source implementation/typecheck/unit tests. [VERIFIED: local CLI checks, 2026-08-15]

**Missing dependencies with fallback:** direct `pnpm`, Android `adb`, and `agent-browser` are absent; the table specifies source-only/manual/cloud fallbacks. [VERIFIED: local CLI checks, 2026-08-15]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest, declared `^3.2.6`, installed `3.2.7` [VERIFIED: packages/happy-app/package.json:201-214; local CLI, 2026-08-15] |
| Config file | `packages/happy-app/vitest.config.ts`; Node environment; exact discovery glob `'sources/**/*.{spec,test}.ts'`. [VERIFIED: packages/happy-app/vitest.config.ts:4-24] |
| Quick run command | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/anchoredActionMenu.test.ts packages/happy-app/sources/components/composerControlMenu.test.ts` [ASSUMED] |
| Full suite command | `packages/happy-app/node_modules/.bin/vitest run && packages/happy-app/node_modules/.bin/tsc -p packages/happy-app/tsconfig.json --noEmit` [VERIFIED: packages/happy-app/package.json:12,23; AGENTS.md:81-85] |

Existing baseline verification on 2026-08-15: `anchoredActionMenu.test.ts` and `keyboardDismissCoordinator.test.ts` passed 8/8 tests in 257ms; App typecheck passed with no output. [VERIFIED: local Vitest/typecheck execution, 2026-08-15]

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| APPUI-01 | Group order is permission/model/effort; model alone shrinks; middle ellipsis policy is used; duplicate action-row controls are absent | pure policy test + typecheck + manual responsive smoke | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/composerControlMenu.test.ts` | No, Wave 0. [ASSUMED] |
| APPUI-02 | Permission uses direct platform menu, transparent backdrop, no keyboard blur, theme follows App | pure dismissal test + iOS/Android/Web manual smoke | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/composerControlMenu.test.ts packages/happy-app/sources/components/anchoredActionMenu.test.ts` | Partial: placement exists; lifecycle test missing. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenu.test.ts:1-62] |
| APPUI-03 | Model/effort groups reorder by trigger, model stays open, effort closes, fallback updates selection, popover stays within viewport and scrolls | pure ordering/dismiss/placement tests + platform smoke | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/composerControlMenu.test.ts packages/happy-app/sources/components/anchoredActionMenu.test.ts packages/happy-app/sources/components/modelModeOptions.test.ts` | Partial: model option and placement tests exist; combined policy missing. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenu.test.ts:1-62; packages/happy-app/sources/components/modelModeOptions.test.ts] |

### Manual/Visual Matrix

| Surface | Required Checks |
|---------|-----------------|
| Web desktop | Light/dark, keyboard/input focus retained, 180ms enter/140ms exit, transparent page, Escape and click-away close, manual close before another trigger opens. [VERIFIED: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:28-38] |
| Web narrow | Widths 320/375/700/701; above-first then flip; horizontal clamp, vertical scroll, no row wrap/overlap; model middle ellipsis. [ASSUMED] |
| iOS native | Light/dark system menu, keyboard retained, model selection remains open and fallback marker updates, effort/permission close; test iOS 15.1-16.3 and 16.4+. [CITED: https://docs.expo.dev/versions/v55.0.0/; https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior] |
| Android native | Transparent anchored menu, keyboard retained, above-first/flip/scroll, model stays open, effort/permission close, backdrop unchanged. [VERIFIED: packages/happy-app/sources/components/NativeSettingsMenu.android.tsx:20-63; packages/happy-app/sources/components/AnchoredActionMenu.tsx:37-153] |

### Sampling Rate

- **Per task commit:** focused `composerControlMenu`/placement Vitest files plus App typecheck. [ASSUMED]
- **Per wave merge:** full App Vitest suite and App typecheck; no local build. [VERIFIED: AGENTS.md:81-93]
- **Phase gate:** Full source suite green, light/dark responsive Web smoke complete, and native iOS/Android lifecycle matrix recorded before `$gsd-verify-work`. [ASSUMED]

### Wave 0 Gaps

- [ ] `packages/happy-app/sources/components/composerControlMenu.test.ts` — group ordering, selected markers, model no-dismiss, permission/effort dismiss, and effort-list refresh policy. [ASSUMED]
- [ ] Extend `packages/happy-app/sources/components/anchoredActionMenu.test.ts` — above-first preference, below fallback, keyboard-constrained height, 320px viewport, and preserving default behavior for non-settings callers. [ASSUMED]
- [ ] iOS compatibility spike — model `Picker`/dismiss modifier behavior on iOS 15.1-16.3 and 16.4+, including live effort fallback marker. [ASSUMED]
- [ ] Web focus/motion smoke harness — confirm input focus survives trigger press and the exit surface stays mounted for 140ms without blocking afterward. [ASSUMED]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Phase adds no authentication surface and must not change provider/session identity. [VERIFIED: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:6-10] |
| V3 Session Management | No direct change | Existing `sessionSetAgentModes` remains the mutation seam; menu visibility is ephemeral UI state. [VERIFIED: packages/happy-app/sources/-session/SessionView.tsx:875-893] |
| V4 Access Control | No authorization change | Permission-mode UI is not an authorization boundary; continue to send only existing recognized mode keys through the existing callback. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1043-1048; AGENTS.md:13-21] |
| V5 Input Validation | Yes | Resolve a selected key through the current option array and ignore unknown keys; never forward arbitrary menu text. Current model/effort handlers already use `.find(...)` then return if absent. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1116-1136] |
| V6 Cryptography | No | No encryption, token, key, or signing behavior changes. [VERIFIED: .planning/phases/06-chat-composer-controls-and-popover-motion/06-CONTEXT.md:6-10] |

### Known Threat Patterns for React Native/Web Menu UI

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged/stale option key | Tampering | Match keys against the current option list and pass the resolved object to existing callbacks. [VERIFIED: packages/happy-app/sources/components/AgentInput.tsx:1116-1136] |
| Click-through behind transparent overlay | Spoofing/Tampering | Full-window transparent `Pressable` consumes click-away input; surface uses modal accessibility semantics and higher stacking order. [VERIFIED: packages/happy-app/sources/components/AnchoredActionMenu.tsx:69-152] |
| Sensitive metadata in diagnostics | Information Disclosure | Add no logs for labels, selections, provider metadata, prompts, or tool data; keep project payload-free logging boundary. [VERIFIED: AGENTS.md:23-27] |
| Unsupported key converted into prompt text | Tampering/Elevation of Privilege | Preserve recognized official mode callbacks only; never add a prompt fallback. [VERIFIED: AGENTS.md:13-21] |

## Sources

### Primary (HIGH confidence)

- `packages/happy-app/sources/components/AgentInput.tsx` - current row/action/picker layout, focus coordination, menu groups, and overlay lifecycle. [VERIFIED: code read 2026-08-15]
- `packages/happy-app/sources/-session/SessionView.tsx` - option derivation, callbacks, and model-effort fallback. [VERIFIED: code read 2026-08-15]
- `packages/happy-app/sources/components/NativeSettingsMenu*.tsx` - iOS/Android/Web presentation contracts. [VERIFIED: code read 2026-08-15]
- `packages/happy-app/sources/components/AnchoredActionMenu.tsx` and `anchoredActionMenuPlacement.ts` - transparent layer and bounds logic. [VERIFIED: code read 2026-08-15]
- `packages/happy-app/sources/components/AnimatedOverlay.tsx` and `FloatingOverlay.tsx` - existing motion/blur behavior. [VERIFIED: code read 2026-08-15]
- Git commits `42af39305ba5c07ea0359211882756b9f5ffbb49`, `e558f8a1337490adf941466bd56b838d85b83808`, and `60d15e8590cb4641adbce91d8c6cba412bce2587` - historical lifecycle and placement changes. [VERIFIED: git show 2026-08-15]

### Secondary (MEDIUM confidence)

- https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/menu/ - Expo UI v55 system Menu, nested content, and Picker support. [CITED: official docs]
- https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/host/ - Host sizing, keyboard safe area, and `colorScheme`. [CITED: official docs]
- https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior - no-dismiss modifier and OS floor. [CITED: official docs]
- https://docs.expo.dev/versions/v55.0.0/ - SDK 55 platform support (`iOS 15.1+`). [CITED: official docs]
- https://reactnative.dev/docs/text#ellipsizemode - `numberOfLines` plus middle ellipsis. [CITED: official docs]
- https://reactnative.dev/docs/the-new-architecture/layout-measurements#measureinwindowcallback - window-coordinate measurement. [CITED: official docs]
- https://reactnative.dev/docs/modal - transparent modal and `onRequestClose`. [CITED: official docs]
- https://docs.swmansion.com/react-native-reanimated/docs/layout-animations/entering-exiting-animations/ - entering/exiting modifiers, reduced motion, and parent/view-flattening caveats. [CITED: official docs]

### Tertiary (LOW confidence)

- GSD research cache entries were fetched through direct official-document Web retrieval because the configured Context7 provider/CLI was unavailable in this agent runtime; implementation assumptions are isolated in the Assumptions Log. [VERIFIED: research-plan/cache seam, 2026-08-15]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - exact dependencies and installed source are present locally; no new package is proposed. [VERIFIED: packages/happy-app/package.json:47-217]
- Architecture: HIGH - current and parent-commit implementations were read, including the old permission trigger and deleted status bar. [VERIFIED: git show/code reads 2026-08-15]
- Web placement/motion: HIGH for primitives, MEDIUM for final sizing/focus behavior - placement and motion patterns exist, but the custom Web menu is not implemented yet. [VERIFIED: packages/happy-app/sources/components/anchoredActionMenuPlacement.ts:36-108; packages/happy-app/sources/components/AnimatedOverlay.tsx:16-41] [ASSUMED]
- iOS dismissal compatibility: MEDIUM on iOS 16.4+, LOW on iOS 15.1-16.3 until the Picker spike is run. [CITED: https://docs.expo.dev/versions/v55.0.0/sdk/ui/swift-ui/modifiers/#menuactiondismissbehaviorbehavior] [ASSUMED]
- Pitfalls: HIGH - most conflicts are direct current-code or git-history observations; older-iOS behavior remains explicitly open. [VERIFIED: code/git reads 2026-08-15]

**Research date:** 2026-08-15
**Valid until:** 2026-09-14 for repository architecture; re-check Expo UI docs and installed version if dependencies change.
