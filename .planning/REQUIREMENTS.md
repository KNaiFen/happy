# Requirements: Happy

**Defined:** 2026-08-15
**Core Value:** 开发者能够跨终端与 App 可靠、安全地控制 Codex 会话，并在断线、重启和恢复场景中保持权威且可重建的状态。

## v1 Requirements

### Supply Chain And Verification

- [ ] **SEC-01**: 维护者可以证明所有外部 GitHub Actions 使用完整 commit SHA，checkout 不持久化凭据，Dependabot 每周维护 Actions 与 npm 依赖
- [ ] **SEC-02**: 维护者可以通过稳定的 `Required CodeQL gate` 验证 Actions、JavaScript/TypeScript、Python 与 Rust，且 docs-only 变更不会留下 pending required check
- [ ] **SEC-03**: 生产依赖的 High、Critical 与未评分 vulnerability 会阻断合并，只有 ADR-006 指定且未过期的精确例外可放行
- [ ] **SEC-04**: 仓库不会在缺少新 ADR、真实部署目标和验收边界时声明自动生产部署或 Environment 审批能力

### Codex Provider And Protocol

- [ ] **CODEX-01**: 未指定的新会话默认选择 Codex，可写会话必须显式携带 `flavor=codex` 与 `codexSyncVersion=4`，未知和遗留 metadata 保持 unsupported
- [ ] **CODEX-02**: Codex 只使用非实验 stable-v2，拒绝低于 `codex-cli 0.145.0` 的版本，recognized controls 只调用官方 RPC 且不回退为 prompt text
- [ ] **CODEX-03**: 只有官方 reasoning summaries 可以同步；raw reasoning 以及 prompt、tool payload、provider ID、token 和密钥不会进入同步或运维日志
- [ ] **CODEX-04**: Gemini、OpenClaw、Agy、generic ACP、共享 v3 基础设施与 sandbox runtime 在仍有消费者时继续保留，不因 vendor 名称被误删

### Sync V4 And Lifecycle

- [ ] **SYNC-01**: Sync v4 的发送队列、ACK、接收 cursor、journal replay、polling 与 snapshot 相互独立，Socket.IO invalidation 仅用于唤醒
- [ ] **SYNC-02**: Server 只存储 opaque encrypted mutations，mutation ID 保持幂等，entity ID、内容与日志遵守现有加密和 payload-free 边界
- [ ] **SYNC-03**: 执行只会被官方 turn completion、权威 non-active provider 状态或 reconciled snapshot 结束，transport loss、RPC timeout 与 elapsed time 只产生 unknown outcome
- [ ] **SYNC-04**: 归档 tombstone、turn-local `eventSequence`、connection health 与 execution state 独立投影，任一轴不会错误清除另一轴
- [ ] **SYNC-05**: Provider-created child threads 形成隔离的只读 side sessions，其 lifecycle 变化不会覆盖 parent runtime state

### Gateway And Official TUI

- [ ] **GATE-01**: 交互式 `happy codex` 运行官方 Codex TUI 并连接持久 Gateway worker，Happy 不 fork、patch 或重实现 TUI
- [ ] **GATE-02**: 异常 detach 后 app-server、turn 与 Sync bridge 可继续运行；attach 复用同一 app-server 并通过 attachment ID 与一次性 nonce 防止迟到确认
- [ ] **GATE-03**: 同一 provider thread 只允许一个 Gateway lease，成功 root handoff 递增 `bindingGeneration`，过期 App 命令在 provider 调用前被拒绝
- [ ] **GATE-04**: Gateway control transport、descriptor、PID identity、文件权限、argv 与日志满足 ADR-004 的跨平台安全边界

### Resume Eligibility

- [ ] **RSUM-01**: `preflight-resume-sessions` 使用加密 machine RPC、独立 32-byte data key 与 `1..25` 有界候选，响应和日志不泄露 path、thread、snapshot、key 或 provider 原始错误
- [ ] **RSUM-02**: daemon 只读检查 Relay snapshot、binding、stable-v2 thread 与 Gateway 状态，不执行 install、unarchive、reconcile、launch、resume、stop 或 provider write
- [ ] **RSUM-03**: 明确缺失才能产生 `ineligible`；Relay、provider 或 Gateway 暂态故障保持 `pending`，`alreadyActive` 只触发投影刷新
- [ ] **RSUM-04**: App 使用不持久化 fingerprint 投影与从请求开始计时的 20 秒 TTL，用户点击 Resume 时绕过缓存并重新执行权威预检

## v2 Requirements

None currently. New capabilities require an explicit accepted decision before promotion into v1.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Legacy provider reactivation | ADR-003 requires a new ADR, schemas, E2E tests and compatibility plan |
| Experimental Codex API usage | Stable-v2 is the supported protocol floor |
| Raw reasoning synchronization | Security boundary permits official reasoning summaries only |
| Automatic production deployment claims | ADR-006 records no current automatic deployment target |
| Remote account login, raw filesystem mutation, plugin marketplace, realtime voice, feedback upload or Windows sandbox management | Explicitly excluded by ADR-001 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 1 | Pending |
| SEC-02 | Phase 1 | Pending |
| SEC-03 | Phase 1 | Pending |
| SEC-04 | Phase 1 | Pending |
| CODEX-01 | Phase 2 | Pending |
| CODEX-02 | Phase 2 | Pending |
| CODEX-03 | Phase 2 | Pending |
| CODEX-04 | Phase 2 | Pending |
| SYNC-01 | Phase 3 | Pending |
| SYNC-02 | Phase 3 | Pending |
| SYNC-03 | Phase 3 | Pending |
| SYNC-04 | Phase 3 | Pending |
| SYNC-05 | Phase 3 | Pending |
| GATE-01 | Phase 4 | Pending |
| GATE-02 | Phase 4 | Pending |
| GATE-03 | Phase 4 | Pending |
| GATE-04 | Phase 4 | Pending |
| RSUM-01 | Phase 5 | Pending |
| RSUM-02 | Phase 5 | Pending |
| RSUM-03 | Phase 5 | Pending |
| RSUM-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 21 total
- Mapped to phases: 21
- Unmapped: 0 ✓

---
*Requirements defined: 2026-08-15*
*Last updated: 2026-08-15 after initial ADR ingestion and roadmap mapping*
