# App 排队消息堆栈与会话恢复资格实施计划

## 状态

- 当前状态：进行中。
- 建立日期：2026-08-06。
- 实施分支：`fix/app-queue-resume-eligibility`，基线为
  `origin/main@0a8e48f90af400ce67c42fd92dee36436cd16b08`。
- 目标版本：Android App `1.11.35`、CLI `1.4.46`；Wire、Server、Relay 和
  happy-agent 不改版本。
- 发布重试：`1.11.34` / `1.4.45` 的 GitHub Actions run 在取消、重跑和强制取消接口
  上返回相互矛盾的控制面状态，无法安全复用。按版本不可复用规则，以无行为差异的下一
  patch 触发全新的发布工作流。
- 完成条件：本计划的代码、源码级测试、翻译、视觉验收、文档检查、独立审查、
  云端 App/CLI 工作流和制品交付全部完成后，移入 `docs/plans/archive/`。

## 问题与设计依据

用户提供的 A、B、C 三张现场图表达了两个独立问题：

1. 输入框上方常驻的“排队/引导”模式格占据空间且与发送流程重复。活动 turn 中的普通
   后续消息应默认进入 durable queue，不再要求用户先选择模式。
2. 已排队消息当前像悬浮卡片插入 composer，与输入框的背景、边界和圆角语言割裂。
   C 的目标不是一个总容器圆角，而是每一层消息自身都有可见的上圆角；最早待执行消息
   位于最底层并贴住输入框，后续消息逐层向上叠放。

首页把“非活跃且未归档”误当成“可恢复”，没有验证独立数据密钥、原机器绑定、官方
Codex thread、目录或 Gateway 冲突。结果是大量旧记录显示 Recoverable 或 Resume，真正
点击后才失败。新的展示必须以同源只读预检为准；无法确认时宁可显示“待验证”，不能
承诺“可恢复”。

## 目标与非目标

### 目标

- 删除 composer 中常驻的 Queue/Steer 选择器；活动 Codex Sync v4 turn 中普通发送固定
  发布 `turn.queue`。
- 保留每条已排队消息的编辑、发送到当前 turn、移除和更多菜单。
- 将排队消息做成与输入框一体的层叠结构，并保证每层独立上圆角、最多三层可见、更多
  消息可滚动访问。
- 只有经过同机 daemon 实时预检且结果仍新鲜的会话才进入首页可恢复历史并显示 Resume。
- 将未检查、检查中、离线、旧 CLI、Relay/provider/Gateway 暂态故障放入独立“待验证”
  分区；终态不可恢复记录从首页隐藏但不删除数据。
- 真正 Resume 继续执行完整权威校验，预检不替代最终校验。

### 非目标

- 不改变 Sync v4 durable queue、FIFO、ACK/cursor 或取消协议。
- 不支持排队消息拖拽重排，也不改变 `queueEntryId`、`queuedAt` 或 replacement 语义。
- 不迁移旧 provider 元数据；空、unknown、legacy provider 仍不获得写入或恢复能力。
- 不删除不可恢复的 session、历史消息或 Relay 数据。
- 不用 transport loss、超时或经过时间推断 provider turn 完成。
- 不在本地构建 Android、CLI 发布包、Web bundle、Tauri 或官方 Codex。

## 排队消息交互与视觉契约

### 发送与排列

- 活跃 Codex v4 turn 中，composer 的普通发送固定使用 `followUpMode: 'queue'`。
- projection 继续按 `createdAt`、`id` 产出 FIFO（最早到最晚）；仅 UI 为形成堆栈而反向
  渲染：最新消息在最上方，最早且下一条待执行消息在最底部并贴近输入框。
- 不改变队列数据顺序，不在 UI state 中复制或重排 durable command。

### 几何

- 每层固定高 `52dp`，相邻层重叠 `4dp`，不得增加重叠量。
- 单层、双层、三层的稳定视口高度分别为 `54dp`、`102dp`、`150dp`；最多直接显示三层。
- 四条以上保留相同 `150dp` 视口、滚动条和 `keyboardShouldPersistTaps="handled"`，所有项
  仍可访问。默认滚动位置锚定最早三条，使下一条待执行消息始终完整贴住 composer；向上
  滚动查看后来入队的消息，新增队列项后重新锚定这一执行端。
- 每层自身设置左右上圆角，并复用当前 composer 轮廓：桌面/Web/iOS 默认 `16dp`，普通
  Android `20dp`，窄屏原生 glass composer `30dp`。圆角不能只放在外层容器，任何中间层的
  上圆角都必须可见。
- ScrollView 只保留 `2dp` 顶部保护空间以免裁切最上层圆角，底部不得留 padding；最底层
  的实际边缘必须直接贴合 composer，不留下透明间隙。
- 队列 dock 保持正常文档流，紧邻 unified composer，不使用 absolute 定位；键盘、
  safe area、自动补全和状态栏继续由现有父布局处理。

### 风格与操作

- 队列层复用 composer 的表面：普通布局使用 `theme.colors.input.background` 与
  `theme.colors.divider`，窄屏原生 glass 布局使用相同的 native glass、background 和
  border token。不使用独立 `surfaceHigh` 卡面或悬浮阴影；输入框和队列看起来是同一个
  composer 系统。
- 每条消息单行预览，长文本尾部省略；空文本沿用附件占位文案。
- Steer、Remove、More 三个直接操作各保持 `44x44dp` 触控区。`4dp` 重叠不得覆盖相邻层
  的有效触控区；窄屏不得缩小操作按钮或让文字挤出容器。
- More 菜单继续包含 Edit、Steer、Remove；请求期间显示 busy/disabled，失败只记录
  payload-free 分类，不记录消息正文、命令参数或 provider 标识符。
- Web 图标按钮保留 title，全部平台保留 accessibility role、label、disabled 和 busy。

## 恢复资格状态模型

App 仅维护不持久化的短期投影：

```ts
type ResumeEligibilityEntry = {
  fingerprint: string;
  state: 'checking' | 'eligible' | 'ineligible';
  checkedAt: number;
  reason?: ResumeEligibilityReason;
};
```

- `eligible`：当前指纹下的独立密钥、Relay snapshot、原机器/metadata/thread/cwd 绑定、
  官方根 thread 和 Gateway/provider 冲突均已通过预检。
- `checking`：未检查、已过期、机器离线、CLI 不支持、Relay/provider 不可用、外部 thread
  活跃、Gateway 恢复中或结果缺失。它从不等价于可恢复。
- `ineligible`：确认 thread 不存在、绑定无效、机器已删除或不支持的 metadata/key。
  只从首页隐藏，不删除 session；详情仍可作为只读历史访问。

### 指纹与新鲜度

- 指纹包含 session ID、active/archive、origin/machine deletion、provider flavor、Sync 版本、
  read-only、machine ID、path、thread ID，以及机器在线和 resume/preflight capability。
- TTL 为 `20s`。`now - checkedAt >= 20s` 时立即失效，不得因为 RPC 完成较晚而额外延长
  一个 TTL。
- 首次进入列表/详情、指纹变化和 TTL 到期触发核验；同一 session+fingerprint 的请求用
  模块级 in-flight map 合并。
- 批量按机器分组，每个 machine RPC 为 `1..25` 项；保持输入顺序，单项失败不得中止
  相邻项。
- RPC 完成时只在当前 storage 指纹仍匹配时应用结果，避免旧请求覆盖新的 lifecycle。

## Daemon 同源只读预检

新增加密 machine RPC：`preflight-resume-sessions`。

请求每项只包含有界的 `sessionId`、`directory`、`threadId` 和瞬时
`dataEncryptionKey`。RPC 边界强制批量 `1..25`、字段长度和 Base64 解码后恰好 32 字节。
响应只返回 session ID、资格分类和稳定原因，不返回路径、thread、snapshot、密钥、
provider 原文或异常堆栈。

每项按以下顺序执行：

1. 用独立 data key 只读加载 Relay snapshot；不把 snapshot 安装进 daemon map。
2. 校验原机器、machine deletion、`flavor=codex`、`codexSyncVersion=4`、metadata machine、
   thread ID、规范化 cwd 和独立 data key。
3. 通过官方 stable-v2 `thread/read`（`includeTurns:false`、`emitSnapshot:false`）验证根 thread
   和 cwd。history inspector 可以按既有空闲策略创建/复用 app-server client，但不得调用
   `thread/resume`、`thread/start`、open coordinator 或任何 provider 写操作。
4. 只读检查受验证的 Gateway descriptor、control status、worker/provider identity。
5. 将结果映射为 `eligible`、`alreadyActive`、`pending` 或 `ineligible`。

预检严禁调用 `installSessionSnapshot`、unarchive、reconcile、Gateway launch/resume/stop 或
修改 session 生命周期。`alreadyActive` 只触发 App 刷新 session，不显示为可恢复。

### 错误分类

| 证据 | 结果 | 首页行为 |
| --- | --- | --- |
| snapshot 明确不存在、密钥形状/独立 key/绑定不符 | `ineligible/invalidBinding` | 隐藏 |
| 官方 thread 明确不存在 | `ineligible/threadUnavailable` | 隐藏 |
| Relay 请求、鉴权、页面解析或解密暂时失败 | `pending/relayUnavailable` | 待验证 |
| app-server/official RPC 暂时失败 | `pending/providerUnavailable` | 待验证 |
| 已验证 Gateway 正承载同一 binding | `alreadyActive` | 刷新 session |
| Gateway 正在切换/恢复 | `pending/gatewayRecovering` | 待验证 |
| provider active 但没有匹配 Gateway | `pending/externalThreadActive` | 待验证 |
| 全部只读校验通过且 provider idle | `eligible` | 可恢复 |

暂态错误不得伪装成终态并从首页消失。真正 Resume 返回 `threadUnavailable` 或
`invalidBinding` 时立即写入终态；`gatewayRecovering`、`externalThreadActive`、
`operationFailed` 和 `outcomeUnknown` 回到待验证。

## App 展示与操作门禁

- 首页顺序：活跃会话 -> 已验证可恢复历史（保留日期/项目分组） -> 待验证分区 ->
  Archive toggle 和归档历史。
- 待验证分区参与搜索、键盘顺序、移动和平板列表选择；文案不能称为 Recoverable。
- `statusUnknown` 仍只表达运行时投影不确定，不能映射为 Recoverable。
- 首页的 `ineligible` 会话被隐藏；详情数据和历史消息不删除，直接 URL 仍可只读访问。
- Resume 按钮只有在 capability、在线状态和新鲜 `eligible` 同时成立时显示；点击前再次
  读取/刷新资格，随后真正 Resume 仍重新执行 thread、binding 和 Gateway 权威校验。
- 成功后刷新 session 并导航到同一 session ID；不得创建替代会话掩盖失败。

## 安全与隐私边界

- data key 只存在于 App 到原机器的加密 RPC 请求和 daemon 局部变量；不写 Zustand、
  session metadata、磁盘、日志或错误响应。
- 外部请求在 App Zod schema 和 CLI RPC handler 两端验证；响应严格拒绝多余字段、错序、
  缺项或未知枚举。
- 日志保持 payload-free：不记录 prompt、消息正文、路径、thread/provider ID、密钥、
  bearer token、tool 参数或供应商原始错误。
- Socket invalidation 只是唤醒提示；资格与 Resume 结果来自请求时的 daemon/provider
  证据，最终 Resume 仍处理检查后发生的竞争。

## 实施步骤

- [x] 固定活动 turn 的普通后续发送为 queue，移除 selector state/props/render。
- [x] 实现每层独立上圆角的队列 stack helper、布局和单元测试。
- [x] 新增 CLI preflight RPC、共用 binding validator、能力字段和边界测试。
- [x] 新增 App 资格缓存、批处理/in-flight、首页分区、详情门禁和多语言文案。
- [x] 删除无引用 selector 文件及仅供其使用的旧翻译键。
- [x] 区分 Relay 暂态失败与终态绑定失败，并补回归测试。
- [x] 修正 TTL 唤醒，使 RPC 完成时刻不会延长陈旧 eligible。
- [x] 审查搜索、平板/移动选择、详情页、四条以上滚动和操作命中。
- [x] 编写并接受 ADR-005，更新文档入口和包 patch 版本。
- [x] 完成源码级测试、类型检查、翻译、文档、安全和 diff 验证。
- [x] 完成桌面/移动、浅色/深色、1/2/3/4+ 条队列的 Playwright 截图验收。
- [ ] 提交、对齐 `origin/main`、推送 `origin/main` 并等待 App/CLI 云端工作流。
- [ ] CLI 成功后下载并验证 `happy-1.4.46.tgz`；Android 只交付 Artifact URL。

## 验证矩阵

### App 单元与类型

- stack：顺序、不可变输入、`54/102/150` 高度、三层上限。
- eligibility：指纹变化、TTL 边界、延迟 RPC 完成、旧 fingerprint 不覆盖、in-flight 合并。
- 首页：eligible、unchecked/checking、ineligible、archived、日期/项目 header 不泄漏、搜索。
- ops：请求 schema、批量顺序、响应严格校验、密钥不出现在响应。
- 现有 queue projection/ops：编辑保持 FIFO identity、steer、cancel。
- 运行受影响测试与 `tsc --noEmit`，并比较全部支持语言键和函数参数。

### CLI 单元与类型

- RPC 边界：空/超 25、字段长度、非对象、非 32-byte key、准确转发。
- preflight：eligible、missing thread、invalid binding、Relay 暂态、provider 暂态、live、
  recovering、external active、逐项隔离和输入顺序。
- material：缺 key challenge、无效 key、snapshot missing、Relay throw 的分类。
- 真实 Resume 和 thread-open 既有测试确保提取 validator 后行为不回归。
- 运行相关 Vitest 与 `tsc --noEmit`；不执行本地 package build。

### 视觉与交互

- 视口：桌面、375px、320px；浅色与深色。
- 队列数量：0、1、2、3、4+；验证每层上圆角、最底层贴输入框、输入框高度稳定、滚动条。
- 键盘/自动补全打开时无重叠；Steer/Remove/More 对每层均可命中，更多菜单对象正确。
- 首页：可恢复、待验证、归档三种状态不混用文案；搜索与窄屏不溢出。

## 发布与回滚

- App 和 CLI 均改变可分发行为，各升一个 patch；不改 Wire schema。
- 预检 capability 独立于旧 Resume capability：旧 CLI 的 App 只显示待验证/升级，不会调用
  未注册 RPC。
- 回滚 App 时 CLI 新 capability/RPC 可保留且无人调用；回滚 CLI 时 App 因 capability 缺失
  保守降级，不显示未验证 Resume。
- 云端工作流一旦为某版本启动，不复用该版本；任何修复继续递增 patch。
