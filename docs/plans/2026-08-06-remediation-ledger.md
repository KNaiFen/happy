# 2026-08-06 安全、恢复与输入队列修复台账

## 状态

- 当前状态：活动；`LOG-01`、`RESUME-01`、`QUEUE-01` 均已解决，未解决问题剩余 0 项；
  集成变更已合入 `main`，正在完成统一发布验收，发布完成后归档本台账。
- 审计基线：`fd967d830bb4bc53250617c8baad440d55ffd17d`。
- 集成分支：`audit/2026-08-06-remediation`；各项依次合入本分支，最终一次合入 `main`。
- 发布策略：全部问题完成后统一触发 CLI、Android App 与 Debian Relay 云端发布。

## 执行规则

1. 选择优先级最高的“待修复”项目并复核当前代码、测试和运行证据。
2. 将该项标记为“进行中”，再修改生产代码。
3. 完成定向测试、源码级类型检查和对应 GitHub CI 后合入集成分支。
4. 记录提交、PR、CI 和验证证据，将该项标记为“已解决”，再开始下一项。
5. 全部项目解决后合入 `main`，验证发布制品和现场链路，再归档本台账。

状态只使用：`待修复`、`进行中`、`已解决`、`已驳回`。

## 项目清单

| 顺序 | 编号 | 严重度 | 状态 | 项目 | 活动计划 |
| ---: | --- | --- | --- | --- | --- |
| 1 | LOG-01 | P1 高 | 已解决 | 语音链路可能把上下文、token、标识符或原始错误写入日志 | [Voice 敏感日志收敛归档](archive/voice-sensitive-logging-hardening-1.11.29-1.1.41.md) |
| 2 | RESUME-01 | P1 高 | 已解决 | 首页旧会话恢复失败、局部 Gateway 假状态及失败后空闲 Gateway 残留 | [旧会话恢复归档](archive/codex-home-old-session-resume-state-regression.md) |
| 3 | QUEUE-01 | P2 中 | 已解决 | 执行期间排队/引导控件嵌入输入框，待发送消息缺少完整管理 | [悬浮待发送条归档](archive/codex-composer-pending-message-dock.md) |

## 已核验现场证据

- 两次首页 Resume 操作均到达本机 daemon、启动 headless Gateway 并调用官方
  `thread/resume`，随后被供应商拒绝并折叠为通用 HTTP 400；App 信息页未显示失败。
- 新启动 Gateway 在 `/root/open` 失败后仍保持 `running/headless` 且没有 current root。
- 设备页通过线程列表、绑定扫描和 `codex-open-thread` 协调器可正常恢复可用线程，证明
  Relay 和机器连接并非整体离线。
- 非活跃会话保留的旧投影会让详情页显示局部“停止中/同步中/已停止 + 未知”，不代表
  当前 Gateway 或 Relay 的权威状态。

运行证据只记录事件分类和结果，不写入会话 ID、线程 ID、路径、token 或供应商原文。

## 已解决证据

- `LOG-01`：实现提交 `4f6ea58e83f69e29162f0f4512ceb56904785c4a`，文档提交
  `17c23a97e293e086e6cf49355bd065e9ef940b0b`；monorepo CI run `31052901664`
  与文档 CI run `31053102538` 均通过。定向 canary、类型检查、独立复核和发布阶段版本见
  [归档计划](archive/voice-sensitive-logging-hardening-1.11.29-1.1.41.md)。
- `RESUME-01`：实现提交 `796e3e4b2e4fec99044a9ae55fd0f9540eece060`，测试契约修正
  `9a271b6f2b3c870113e0a15adcd6acfb44428423`；monorepo CI run
  [`31060623946`](https://github.com/KNaiFen/happy/actions/runs/31060623946) 的完整矩阵与
  Required gate 均通过。定向测试、全量 CLI 单测和阶段版本见
  [归档计划](archive/codex-home-old-session-resume-state-regression.md)。
- `QUEUE-01`：实现提交 `62f09e35bcfe19dbd3e02355c5a417a66ebb75b8`；Wire schema
  `8/8`、CLI processor `18/18`、App projection/ops `39/39`、受影响三包类型检查、
  全语言键一致性以及 `git diff --check` 均通过。浏览器实测 radio 为 `91×44px`，方向键、
  ARIA、320px 滚动与输入框边界均正确；[同一 HEAD 的 monorepo CI](https://github.com/KNaiFen/happy/actions/runs/31066864724)
  全绿，详见 [归档计划](archive/codex-composer-pending-message-dock.md)。

## 发布验收进度

- 集成 PR [#19](https://github.com/KNaiFen/happy/pull/19) 已合入 `main`，合并提交为
  `8aeaa377620a2079c7789c6ade9407cd96aea48a`；同一 HEAD 的 monorepo CI run
  [`31068692915`](https://github.com/KNaiFen/happy/actions/runs/31068692915) 已通过。
- CLI `1.4.44`、Android App `1.11.31` 与 Debian Relay `1.1.41` 的首轮云端构建均通过；
  Android 现场 E2E run
  [`31068692919`](https://github.com/KNaiFen/happy/actions/runs/31068692919) 发现 Maestro 仍按旧 tab
  语义断言 `selected`。失败层级中 `Queue` 是 `android.widget.RadioButton`，状态为
  `checked=true`、`selected=false`，截图也确认控件可见且已选中，因此这是验收契约错位，
  不是产品视觉或交互失败。
- 现场流程改用 radio 对应的 `checked` 断言；`1.11.32` 的 Android 构建 run
  [`31071637007`](https://github.com/KNaiFen/happy/actions/runs/31071637007) 已通过，制品已核验为
  `com.ex3ndr.happy`、`versionCode 11132`、OTA 关闭，且构建提交为
  `5778288b043e91b7fc0e1753dac95b43df737037`。
- 同一提交的 Android 现场 E2E run
  [`31071637117`](https://github.com/KNaiFen/happy/actions/runs/31071637117) 继续发现一个过期验收：
  发送 `Q` 后脚本直接断言“Edit queued message”，但失败截图和无障碍层级确认 `Q` 已显示在
  `codex-queued-message-dock`，并提供“Send to active turn”“Remove queued message”及
  “More queued-message actions”。编辑按已实现的设计位于更多菜单中。
- 现场流程改为打开更多菜单后断言编辑、引导、移除三项，并等待队列 dock 被当前轮次取走。
  由于 `1.11.32` 的发布工作流已经运行，最终 App 版本继续按不可复用规则顺延为 `1.11.33`，
  等待同一 HEAD 的现场 E2E 与 Android 构建重新通过。

## 目标版本

- Android App：`1.11.33`；CLI：`1.4.44`；Debian Relay：`1.1.41`。
- Wire 保持 `0.1.8`，happy-agent 保持 `0.1.9`。
- 任一发布版本的工作流一旦运行，不论成功与否都不得复用该版本。
