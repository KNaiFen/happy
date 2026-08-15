# Roadmap: Happy

## Overview

本路线图把已经接受并部署的 ADR 约束转换为五个可独立验证的维护边界。阶段目标不是重复实现现有架构，而是确保供应链、Codex 协议、Sync v4、Gateway 与恢复预检持续拥有与当前代码一致的 source-level、cloud CI 或运行时证据。

## Phases

- [ ] **Phase 1: Supply Chain Verification** - 建立 Actions、CodeQL 与生产依赖门禁的持续证据
- [ ] **Phase 2: Codex Protocol Boundary** - 验证 Codex-only、stable-v2 与隐私边界
- [ ] **Phase 3: Sync V4 Integrity** - 验证 durable sync、权威 lifecycle 与 child isolation
- [ ] **Phase 4: Gateway TUI Continuity** - 验证官方 TUI、detach/attach、lease 与 generation
- [ ] **Phase 5: Resume Eligibility Preflight** - 验证同源只读预检和 App 保守投影
- [ ] **Phase 6: Chat Composer Controls And Popover Motion** - 统一聊天输入区控制布局与无闪烁弹窗动画

## Phase Details

### Phase 1: Supply Chain Verification
**Goal**: 维护者可以在合并前获得与 ADR-006 一致、稳定且不夸大部署能力的供应链证据
**Depends on**: Nothing (first phase)
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. 外部 Action 可被静态验证为完整 SHA pin，checkout credentials 不会持久化
  2. Source 与 docs-only PR 都会得到终态明确的稳定 CodeQL required gate
  3. High、Critical 和未评分生产 vulnerability 会失败，精确例外在 ID、path、patch 状态或期限变化时 fail closed
  4. 仓库状态与文档不会把不存在的自动部署目标或审批门禁描述为已提供能力
**Plans**: TBD

### Phase 2: Codex Protocol Boundary
**Goal**: 新会话与远程控制始终进入显式、稳定、payload-free 的 Codex-only 协议路径
**Depends on**: Phase 1
**Requirements**: CODEX-01, CODEX-02, CODEX-03, CODEX-04
**Success Criteria** (what must be TRUE):
  1. 未指定会话与 `happy codex` 选择同一 Codex 路径，legacy/unknown metadata 得到显式 unsupported 结果
  2. 最低和最新支持的 Codex stable-v2 schema 都通过云端验证，experimental API 保持关闭
  3. Recognized controls 使用官方 RPC，缺失能力会显式失败且不会变成普通 prompt
  4. 同步与日志只包含官方 reasoning summary 和无 payload 的运维字段，保留集成不会被 provider 清理误伤
**Plans**: TBD

### Phase 3: Sync V4 Integrity
**Goal**: Codex canonical state 在断线、重启、重放和 snapshot 恢复中保持加密、可重建且生命周期权威
**Depends on**: Phase 2
**Requirements**: SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05
**Success Criteria** (what must be TRUE):
  1. 丢失、重复或延迟的 Socket.IO invalidation 不会丢失或错误完成 canonical state
  2. Journal、ACK、cursor、revision 与 snapshot 故障可被独立恢复，Server 无需解密 provider entity
  3. Transport loss、RPC timeout 和 elapsed time 只显示未知或待对账，不会把运行中的 turn 变为 completed
  4. 归档、timeline order、connection 与 execution 各自由其权威证据驱动
  5. Child thread 的更新只影响其 side session 与 relation，parent runtime state 保持不变
**Plans**: TBD

### Phase 4: Gateway TUI Continuity
**Goal**: 开发者可以通过官方 Codex TUI 与 App 控制同一持久 Gateway，而不会产生重复 runtime、陈旧命令或不安全控制面
**Depends on**: Phase 3
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04
**Success Criteria** (what must be TRUE):
  1. `happy codex` 呈现官方 TUI 行为，非交互官方子命令透明委派且不创建 Happy session
  2. 异常终端断开后 provider turn 与 Sync bridge 继续存在，重新 attach 使用同一 app-server 重建 TUI 历史
  3. Thread lease 阻止双 Gateway，过期 generation 命令不会到达 provider
  4. POSIX/Windows control transport、capability、PID identity、权限、argv 与日志通过安全验证
**Plans**: TBD
**UI hint**: yes

### Phase 5: Resume Eligibility Preflight
**Goal**: App 只把具有同机权威证据的会话展示为可恢复，并在最终 Resume 前重新验证全部条件
**Depends on**: Phase 4
**Requirements**: RSUM-01, RSUM-02, RSUM-03, RSUM-04
**Success Criteria** (what must be TRUE):
  1. 批量 preflight 对候选、字段与独立 key 执行边界校验，响应和日志不暴露敏感证据
  2. 首页资格探测不会安装 snapshot、取消归档、启动 Gateway 或修改 session lifecycle
  3. 暂态 Relay、provider 或 Gateway 故障保持 pending，只有明确无效证据会隐藏候选
  4. Fingerprint、in-flight 合并、请求起点 TTL 和旧回包丢弃保持保守；点击 Resume 时强制重新预检
**Plans**: TBD
**UI hint**: yes

### Phase 6: Chat Composer Controls And Popover Motion

**Goal**: Happy App 聊天页的模型、思考程度与权限控制以一致、稳定且无闪烁的交互呈现在消息发送框上方
**Depends on**: Nothing (independent App UI phase)
**Requirements**: APPUI-01, APPUI-02, APPUI-03
**Success Criteria** (what must be TRUE):

  1. 模型、思考程度和权限组件均贴在消息发送框上方，模型与思考程度依次位于权限组件右侧，最右侧保留协调间距
  2. 权限窗口打开和关闭时不发生背景闪烁，并具有平滑动画
  3. 实现对照被移除的旧权限按钮代码，复用或恢复其稳定的背景与动画生命周期处理
  4. 模型和思考程度窗口采用相同的无闪烁动画模式
  5. 在 Happy App 支持的聊天页面尺寸下，控件不重叠、不溢出，布局保持可用

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5; Phase 6 is independent

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Supply Chain Verification | 0/TBD | Not started | - |
| 2. Codex Protocol Boundary | 0/TBD | Not started | - |
| 3. Sync V4 Integrity | 0/TBD | Not started | - |
| 4. Gateway TUI Continuity | 0/TBD | Not started | - |
| 5. Resume Eligibility Preflight | 0/TBD | Not started | - |
| 6. Chat Composer Controls And Popover Motion | 0/TBD | Not started | - |
