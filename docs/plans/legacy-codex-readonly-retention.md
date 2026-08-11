# Codex 历史会话只读保留计划

## 状态

- 当前状态：进行中（2026-08-12 已开始实现，等待 App 定向测试与云端 CI 验收）。
- 负责范围：`happy-app` 会话 schema、显示/操作门禁、ADR-001 与发行矩阵。
- 已接受决策：明确标记为 `flavor=codex` 但缺失或非 `codexSyncVersion=4` 的历史记录可读保留；不提供发送、恢复、fork、归档或删除能力。空、未知和非 Codex 旧 provider 元数据仍不显示为受支持会话。
- 版本边界：该 App 可见行为变更将 `happy-app` 从 `1.11.46` 提升至 `1.11.47`；不改变 CLI、Server 或 Wire 协议。
- 本机证据：`vitest run` 已通过 110 个文件、1046 项断言；翻译比较确认 10 种语言的 857 个 key 形状一致。包级 `tsc --noEmit` 仍因工作树未生成 `@slopus/happy-wire` 声明文件而在既有 Sync v4 文件中失败，最终以云端完整构建顺序为准。

## 背景与证据

现有 `MetadataSchema` 只接受字面量 `codexSyncVersion=4`，导致明确的旧 Codex
记录在解密后被丢弃。列表和直链又以“支持写入”为条件过滤，因此这些历史记录会被
错误显示为已删除。CLI 的恢复预检已经拒绝非 v4 binding；该拒绝继续保留。

## 实施步骤

1. [x] 将 schema 放宽为非负整数版本，以便解密和显示明确的旧 Codex metadata。
2. [x] 将“可读取”与“可写入”分离：仅显式 v4 可写；旧 Codex 统一进入只读门禁。
3. [x] 让列表、会话页和详情页显示只读历史，并移除所有可变操作入口。
4. [x] 为 schema、分类、能力门禁补充定向测试，并复用既有 RPC 零调用测试。
5. [ ] 在 App 定向测试和 GitHub Actions 同一 head 成功后，记录 run URL、归档本计划并更新索引。

## 验收标准

- `flavor=codex` 且版本缺失、3 或 5 的记录可显示并可读取现有加密内容。
- 这些记录的 composer、工具交互、resume、fork、archive、delete 和所有 RPC/HTTP 写入均不可达。
- 空、unknown、Gemini、OpenClaw、Agy、ACP 等 metadata 不会被推断为 Codex 或可写会话。
- App 版本、ADR、活动计划、生成发行矩阵和 CI 证据保持一致。
