# 2026-08-06 安全、恢复与输入队列修复台账

## 状态

- 当前状态：活动；`LOG-01` 已解决，`RESUME-01` 进行中，未解决问题剩余 2 项。
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
| 2 | RESUME-01 | P1 高 | 进行中 | 首页旧会话恢复失败、局部 Gateway 假状态及失败后空闲 Gateway 残留 | [旧会话恢复](codex-home-old-session-resume-state-regression.md) |
| 3 | QUEUE-01 | P2 中 | 待修复 | 执行期间排队/引导控件嵌入输入框，待发送消息缺少完整管理 | [悬浮待发送条](codex-composer-pending-message-dock.md) |

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

## 目标版本

- Android App：`1.11.31`；CLI：`1.4.44`；Debian Relay：`1.1.41`。
- Wire 保持 `0.1.8`，happy-agent 保持 `0.1.9`。
- 任一发布版本的工作流一旦运行，不论成功与否都不得复用该版本。
