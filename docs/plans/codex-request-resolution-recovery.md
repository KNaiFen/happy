# Codex 请求回答可靠性与重启恢复实施计划

## 状态

- 当前状态：进行中。
- 建立日期：2026-08-08。
- 实施分支：`fix/codex-request-resolution`。
- 基线：`origin/main@01a2278c033e279da1ca0a52cefdbfb6746a1b15`。
- 目标版本：`packages/happy-app` `1.11.40`；CLI 保持 `1.4.46`，Wire 保持 `0.1.8`。
- 权威边界：[ADR-001](../decisions/ADR-001-codex-sync-v4.md) 规定命令不可变、未知结果不可重放和 provider request ID 精确绑定；[权限解析](../permission-resolution.md) 规定 pending request 必须由持久 Sync v4 实体恢复，传输中断不代表请求完成。

## 现场与根因

目标会话中的 MCP elicitation 从前一天持续显示旋转和七万多秒，但 provider 实际正在等待用户回答，并非持续执行 MCP。用户重新打开 App 后仍能看到选项；点击提交时，App 发布了一个 `request.resolve` 命令，但命令没有 `bindingGeneration`。CLI Gateway 在 provider 调用前执行严格 generation 守卫，按 `undefined !== 1` 将命令取消并记录 `bindingSuperseded`，所以回答从未到达 request broker。

现场的两次点击都形成了持久的 `received -> executing -> cancelled` commandResult，原 `codex.request` 仍为 `pending`。当前 App 又存在三项投影缺口：

1. `request.resolve` 的失败被投影为独立 `CodexControlCommand` 错误卡，没有回连原请求卡片。
2. `AskUserQuestionView`、`McpElicitationView` 和 `PermissionFooter` 分别使用组件本地布尔值判断“已提交”；App 重启、跨设备同步或持久命令失败后，这些布尔值都不是事实来源。
3. pending 用户输入被投影成普通 `running` tool；`ToolView` 因此显示 spinner，并从 request 创建时间开始累计秒数。thinking 行又会在 pending request 存在时被隐藏，形成“没有思考中，但工具一直运行”的错误外观。

## 目标

1. 所有面向当前 Gateway 的 App provider 命令携带当前 runtime generation；已有 Gateway 但缺 generation 的命令在 App 本地拒绝，不能写入必败 outbox。
2. 队列 edit、cancel、steer 继续保留原队列命令 generation，不得被当前 generation 覆盖。
3. 用持久的 `codex.request`、`codex.command`、`codex.commandResult` 推导请求交互状态，App 重启和同步重放后得到相同 UI。
4. 回答失败在原请求卡片内显示；可安全重试的失败保留选择和操作，未知结果禁止重复提交。
5. 等待用户回答的请求显示静态状态，不显示工具 spinner 或不断增长的执行秒数；其他真正运行中的工具维持现状。
6. 使用真实官方 Codex app-server 与 MCP SDK elicitation 完成 Android API 36 现场验收：请求 pending 时退出 App，重开会话后选择、提交并让原 turn 继续。

## 非目标与安全边界

- 不放宽 CLI generation 守卫，不把 missing/stale generation 当成当前 binding。
- 不把真实 draining Gateway 上的 pending request 自动转投新 session 或新 Gateway。
- 不自动重放 `resultUnknown` / `notReplayed` 的非幂等 `request.resolve`。
- 不从 elapsed time、App/CLI transport loss、interrupt ACK 或 RPC timeout 推断 request/turn 完成。
- 不改变 Sync v4 Wire schema；交互状态是 App 对现有实体的纯投影。
- 不记录 request 内容、选项、回答、provider ID、工具参数或输出到操作日志。
- 不在本地构建 Android、CLI、Web bundle、Tauri、官方 Codex 或发布制品。

## Generation 合约

### 当前命令

当前 generation 只从选中 session 的 `projection.runtime.gateway.generation` 读取。普通 `turn.start`、`turn.queue`、`turn.steer` 和文本解析出的控制命令已经遵守该规则；本次补齐直接操作：

- `sessionAbort` -> `turn.interrupt`；
- `sessionGoalAction` -> `goal.set` / `goal.clear`；
- `resolveCodexV4Request` -> `request.resolve`。

App 的中央发布校验在实体进入 outbox 前执行：若 runtime 已有合法 Gateway generation，而命令没有显式 `bindingGeneration`，立即抛出本地错误。校验只拒绝“缺失”，不要求命令等于当前值，因为队列 lineage 需要显式保留旧 generation，并交给 CLI 守卫决定其是否仍可执行。

### 队列 lineage

以下 replacement/cancel 命令必须继续复制 `queued.command.bindingGeneration`：

- `sessionUpdateCodexQueuedMessage`；
- `sessionCancelCodexQueuedMessage`；
- `sessionSteerCodexQueuedMessage`。

中央发布入口不得为它们改写 generation。若原 binding 已过期，CLI 在任何 provider side effect 前取消；App 不能悄悄把旧队列项送进新 Gateway。

```txt
User submits a current request response
|
+- resolveCodexV4Request(sessionId, requestId, ...)
|  +- resolve owned (threadId, requestId)
|  +- read projection.runtime.gateway.generation
|  `- publish immutable request.resolve + bindingGeneration
|
+- assertCodexV4CommandPublishAllowed(...)
|  +- current Gateway + missing generation -> reject before outbox
|  `- explicit generation -> preserve unchanged
|
`- CLI beforeProviderCall(command)
   +- matching generation -> requestBroker.resolve(...)
   `- missing/stale generation -> cancelled(bindingSuperseded)
```

## 持久化交互状态机

### 匹配与 attempt 选择

回答命令只能通过以下组合键关联原请求：

```ts
type RequestKey = readonly [threadId: string, requestId: string];
```

- `request.resolve.threadId` 必须等于 request 的 `threadId`。
- `request.resolve.payload.requestId` 必须等于 request 的 `requestId`。
- 禁止只按 `requestId` 匹配，避免 provider 在不同 thread 复用 ID 时串线。
- 同一 key 有多个回答命令时，按 `createdAt`、`commandId`、`providerId` 的确定性顺序选择最新 attempt。
- 每个 attempt 只读取该 `commandId` 最新 revision 的 commandResult；request 终态永远优先于 command 状态。

### 七种状态

```ts
type CodexRequestInteractionState =
    | 'awaitingInput'
    | 'submitting'
    | 'awaitingConfirmation'
    | 'retryableError'
    | 'outcomeUnknown'
    | 'unavailable'
    | 'settled';
```

| request / 最新 attempt | 投影状态 | UI 与重试规则 |
| --- | --- | --- |
| `pending`，没有 attempt | `awaitingInput` | 表单/审批按钮可用；标题区显示静态“等待你的回答”；无 spinner、无秒数。 |
| `pending`，命令尚无结果或结果为 `received` / `executing` | `submitting` | 保留已选内容但禁用编辑和重复提交；不把本地 Promise 完成当成功。 |
| `pending`，结果为 `succeeded` | `awaitingConfirmation` | 等待 request 自身同步终态；禁用重复提交。 |
| `pending`，结果为 `failed` / `cancelled` | `retryableError` | 在原卡片显示错误；保留/恢复 attempt response；允许用户显式重试并产生新命令。 |
| `pending`，结果为 `resultUnknown` / `notReplayed` | `outcomeUnknown` | 显示结果未知；禁止重试，等待 request/provider 权威收束。 |
| request `error` 且 response.error 为 `providerResponseOutcomeUnknown` | `outcomeUnknown` | 禁止重试，不把未知结果改写为失败。 |
| request `error` 的其他原因 | `unavailable` | 显示 provider request 已不可用；不重放旧回答。 |
| request `accepted` / `declined` / `cancelled` / `resolved` | `settled` | 只由 request 终态显示已回答/取消结果。 |

`requestInteraction` 投影同时携带最新 `commandId`、已提交 response 和无 payload 的错误文本，使组件能在重启后恢复选择与错误位置。组件可以保留“正在编辑的选择”和一次本地发布错误，但不能保留或推断“已成功提交”。

### 增量投影

`CodexV4ProjectionIndexes` 增加两个 thread-scoped 索引：request key 到 request provider entity，以及 request key 到 `request.resolve` command entities。request、command 或 commandResult 变更都必须把原 request message 标记为 affected；删除、snapshot replace 与 selected-thread 切换使用同一索引规则。

`request.resolve` commandResult 无论成功或失败都不再生成独立 `CodexControlCommand` 卡片。失败、未知和不可用状态只在原 `AskUserQuestion` / `CodexApproval` 卡片内出现；其他控制命令的投影不变。

```txt
codex.request / codex.command / codex.commandResult mutation
|
+- applyCodexV4ProjectionUpdates(...)
|  +- update RequestKey indexes
|  +- mark source request message affected
|  `- derive latest request interaction state
|
+- projectRequestMessage(...)
|  +- tool.requestInteraction = durable derived state
|  +- pending request keeps tool content visible
|  `- terminal request remains authoritative
|
`- React re-render
   +- AskUserQuestionView / McpElicitationView / PermissionFooter
   |  +- local state = editable values only
   |  `- durable state = submit/confirm/error/settled truth
   `- ToolView
      +- awaiting user response -> static label
      `- no request spinner or elapsed timer
```

## 组件行为

### 通用规则

- `awaitingInput` 与 `retryableError` 可编辑、可提交；其他非终态禁用重复操作。
- 点击时可以用组件本地 loading 防双击，但本地 Promise resolve 后不能显示 settled。
- 本地 outbox 发布失败显示本地化通用错误并恢复操作；持久 commandResult 错误显示在同一 request 卡片。
- `submitting` / `awaitingConfirmation` 的状态在 App 重启后继续显示。
- `outcomeUnknown` 和 `unavailable` 不显示重试按钮；provider 重启收束出的 request error 不重放 response。
- provider 或其他设备同步 request 终态后，组件立即切到真实结果，不依赖本机是否点击过。

### AskUserQuestionView

- 删除 `isSubmitted` 作为成功权威；仅在 `settled` / request 终态时显示回答结果。
- 从最新 attempt response 的 `{ answers: { [questionId]: { answers: string[] } } }` 恢复选择。
- `retryableError` 继续显示问题与选择；提交新 attempt 后旧错误由最新 attempt 取代。

### McpElicitationView

- 删除 `submittedAction` 作为成功权威。
- 从最新 attempt 的 `{ action, content }` 恢复 form/json/url 选择。
- `form` 单选继续使用 `accessibilityRole="radio"` 与 `accessibilityState.checked`；重启后 checked 状态必须恢复。
- accept/cancel 只有 request 终态才能进入结果视图。

### PermissionFooter

- 按钮 busy/disabled 同时受本地防双击状态与持久交互状态控制。
- `retryableError` 恢复审批按钮；未知/不可用状态保持禁用并显示卡片内说明。
- 不新增独立 modal、toast 或底部面板承载错误。

### ToolView

- 任何带 `requestInteraction` 的 pending request 都不渲染普通工具 elapsed timer。
- `awaitingInput` 显示静态本地化状态；提交、确认、错误、未知和不可用使用各自短状态。
- 非 request 的 `running` tool 保持 spinner 与 elapsed timer，避免扩大视觉变更。

## i18n

在 `tools.requestResponse` 下新增共享文案：等待回答、提交中、等待 provider 确认、提交失败、结果未知、请求不可用。英文 `_default` 与 `_all.ts` 声明的全部 locale 必须保持相同对象形状和动态参数；紧凑标题状态使用短句，错误说明允许换行且不得截断。

## Android Field E2E

### 真实 MCP fixture

- 保留现有 `record_field_event`，新增 `collect_field_choice`，避免破坏 Gateway TUI fixture。
- 新工具通过 MCP SDK `server.server.elicitInput()` 发送 `mode: 'form'`，唯一单选为 `Resume after restart` / value `resume`。
- 仅收到 `action === 'accept'` 且 `content.choice === 'resume'` 时返回成功 marker；cancel/decline/错误不能通过验收。
- Responses fixture 增加可选 `fixtureMcpToolName`，默认仍是 `record_field_event`；只有 Android fixture 选择新工具。

### Maestro 时序

1. 启动真实 app-server、Sync v4 CLI、Relay、App 和 MCP server。
2. 发送 field prompt，并在 turn 活跃时保留现有 `Q` durable queue 断言。
3. 等待 `collect_field_choice` 的 elicitation 卡片出现，但不回答。
4. `pressKey: home` 后 `killApp`，确保重启发生在 request 仍 pending 时。
5. 重开 App、进入同一会话；必要时沿用现有 Terminals fallback。
6. 滚动到 elicitation，断言 header 没有运行秒数，点击 radio `Resume after restart`，断言 `checked=true`，再点击 Submit。
7. 等待 request settled、MCP success marker、原 turn 最终回复和 `Q` queue dock 消失。
8. 断言没有 `request.resolve` 的内部 `CodexControlCommand` 卡片，并由 fixture diagnostic 的 `mcpChoiceAccepted` 证明不是泛化 tool output 误通过。

## 实现文件边界

- `packages/happy-app/sources/sync/codexV4Commands.ts`：当前 runtime generation helper。
- `packages/happy-app/sources/sync/codexV4Capabilities.ts`：中央 generation 发布不变量。
- `packages/happy-app/sources/sync/ops.ts`：interrupt、goal、request.resolve generation。
- `packages/happy-app/sources/sync/typesMessage.ts`：请求交互投影类型。
- `packages/happy-app/sources/sync/codexV4Projection.ts`：thread-scoped 索引、七态推导、affected 重投影、控制卡抑制。
- `packages/happy-app/sources/components/tools/ToolView.tsx` 及三个请求交互 view/footer：静态等待态、持久 submit/error/settled UI。
- `packages/happy-app/sources/text/translations/*.ts`：全部 locale 共享文案。
- App/CLI 相关单测：generation、状态机、跨 thread、重复 attempt、重启恢复与 broker 前守卫。
- `scripts/ci/codex-field-mcp-server.mjs`、Responses/Android fixture、Maestro flow 与 Field E2E 断言：真实 elicitation 重启链路。
- `packages/happy-app/package.json`：行为变更 patch 版本。
- `docs/permission-resolution.md`、`docs/agent-testing.md`：当前交互恢复与真实现场验收契约。

## 验证矩阵

### App generation

- 当前 runtime 存在时，interrupt、goal.set、goal.clear、request.resolve 均携带 generation。
- 中央发布校验拒绝缺 generation；没有 runtime Gateway 时维持启动兼容。
- 队列 edit/cancel/steer 保留原 generation，即使当前 runtime generation 已变化也不改写。

### 状态机与投影

- 覆盖七态和全部 commandResult 状态。
- request 终态优先于未完成/失败 command。
- 同一 request 多 attempt 只选择最新；更新、删除、snapshot rebuild 后结果一致。
- 相同 request ID 跨 thread 不串线；selected thread 切换只显示所属实体。
- `request.resolve` failure 不再生成独立控制卡。

### 组件

- `awaitingInput` 无 spinner、无 elapsed timer，显示静态等待文案。
- submitting/confirmation 重挂载后仍禁用重复提交。
- retryable error 保留选择并可再提交；settled 只由 request 终态触发。
- resultUnknown/outcomeUnknown 无重试入口。

### CLI

- matching generation 的 `request.resolve` 到达 request broker。
- missing/stale generation 的 interrupt、goal.set、goal.clear、request.resolve 均在 provider/broker side effect 前取消。
- provider 重启把 pending request 收束为 unavailable，把 responseReady/responseSupplied 收束为 outcomeUnknown，且不重放 response。

### 本地源码命令

```bash
pnpm --filter happy-app exec vitest run <targeted App specs>
pnpm --filter happy-app exec tsc --noEmit
pnpm --filter happy-app exec tsx sources/scripts/compareTranslations.ts
pnpm --filter happy exec vitest run --project unit <targeted CLI specs>
pnpm --filter happy exec tsc --noEmit
pnpm docs:sync
pnpm docs:check
```

本机只运行源码级检查；无全局 pnpm 时使用已有 worktree 的 package-local Node binaries执行等价命令，并记录实际命令。

### 云端验收

- 推送 `origin/main` 后等待 Documentation、Monorepo CI、Android Release、Official Codex API 36 Field E2E 全部到终态。
- 任何失败都先定位证据并修复；已经运行过的 App 版本不复用，继续提升 patch。
- Android 成功后提供 GitHub Artifact URL，不默认下载 APK。

## 执行步骤

- [ ] 建立详细活动计划并通过 docs 同步检查。
- [ ] 完成 generation helper、直接命令补齐和中央缺失校验。
- [ ] 完成七态纯投影、thread-scoped 索引与内部控制卡抑制。
- [ ] 改造三个请求交互组件与 ToolView，更新全部 locale。
- [ ] 补齐 App/CLI 单测与组件级行为测试。
- [ ] 扩展真实 MCP elicitation Android Field E2E。
- [ ] 提升 App patch 版本并执行全部本地源码检查。
- [ ] 完成 findings-first 独立审查并修复全部 blocking findings。
- [ ] 更新当前文档、归档本计划、运行 docs:sync/docs:check。
- [ ] 分步中文提交，推送 `origin/main`，监控全部 Actions 并交付 Artifact URL。
