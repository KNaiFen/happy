---
phase: 06
slug: chat-composer-controls-and-popover-motion
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-15
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.2.7 + TypeScript 5.9.3 |
| **Config file** | `packages/happy-app/vitest.config.ts` |
| **Quick run command** | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/anchoredActionMenu.test.ts packages/happy-app/sources/components/composerControlMenu.test.ts --passWithNoTests` |
| **Full suite command** | `packages/happy-app/node_modules/.bin/vitest run && packages/happy-app/node_modules/.bin/tsc -p packages/happy-app/tsconfig.json --noEmit` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run the quick Vitest command above.
- **After every plan wave:** Run the full App Vitest suite and App typecheck.
- **Before `$gsd-verify-work`:** Full source suite must be green and the manual platform matrix must be recorded.
- **Max feedback latency:** 30 seconds for automated source checks.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 0 | APPUI-01, APPUI-03 | — | N/A | unit | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/composerControlMenu.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 0 | APPUI-02, APPUI-03 | T-06-01 | Transparent click-away layer consumes input without forwarding arbitrary option keys | unit | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/anchoredActionMenu.test.ts` | ✅ extend | ⬜ pending |
| 06-02-01 | 02 | 1 | APPUI-01 | — | N/A | source/type | `packages/happy-app/node_modules/.bin/tsc -p packages/happy-app/tsconfig.json --noEmit` | ✅ | ⬜ pending |
| 06-02-02 | 02 | 1 | APPUI-02, APPUI-03 | T-06-01, T-06-02 | Selected keys resolve through current option arrays; no payload or selection logging | unit + type | `packages/happy-app/node_modules/.bin/vitest run packages/happy-app/sources/components/composerControlMenu.test.ts packages/happy-app/sources/components/anchoredActionMenu.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 2 | APPUI-01, APPUI-02, APPUI-03 | — | N/A | full source | `packages/happy-app/node_modules/.bin/vitest run && packages/happy-app/node_modules/.bin/tsc -p packages/happy-app/tsconfig.json --noEmit` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/happy-app/sources/components/composerControlMenu.test.ts` — group ordering, selected markers, model no-dismiss, permission/effort dismissal, and refreshed effort selection policy.
- [ ] `packages/happy-app/sources/components/anchoredActionMenu.test.ts` — above-first preference, below fallback, keyboard-constrained height, 320px viewport clamp, and unchanged default behavior for existing non-settings callers.
- [ ] iOS compatibility spike — verify model selection remains open and displays automatic effort fallback on iOS 15.1–16.3 and iOS 16.4+; stop for a product/support-boundary decision if the older range cannot satisfy both D-07 and D-09.
- [ ] Web focus/motion smoke harness — verify input focus and keyboard remain stable, the surface exits for 140ms, and the transparent layer no longer blocks interaction after unmount.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| iOS native menu lifecycle across supported OS range | APPUI-02, APPUI-03 | SwiftUI menu dismissal differs before iOS 16.4 and cannot be proven by Node tests | On iOS 15.1–16.3 and 16.4+, open each menu with the keyboard visible; verify permission/effort close on selection, model stays open, automatic effort fallback becomes selected, App theme is followed, and the background does not change. |
| Android anchored menu lifecycle | APPUI-02, APPUI-03 | Requires native window measurement, keyboard, and modal behavior | With the keyboard visible, open each trigger near viewport edges; verify above-first placement, flip/clamp/scroll behavior, transparent background, dismissal policy, and no click-through. |
| Web responsive layout and motion | APPUI-01, APPUI-02, APPUI-03 | Visual geometry, focus, and animation timing require a rendered browser | At widths 320, 375, 700, 701, and 1024 in light/dark themes, verify a single non-wrapping permission/model/effort row, middle model ellipsis, trailing gap, per-trigger anchoring, viewport clamping, 180ms entry, 140ms exit, Escape/click-away close, unchanged background, and retained input focus. |
| Manual-close exclusivity | APPUI-02, APPUI-03 | Cross-trigger pointer behavior spans platform menu hosts | While one window is open, press another trigger and verify no direct switch occurs; close the first window manually, then verify the second can open. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verification or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verification.
- [ ] Wave 0 covers all missing references.
- [ ] No watch-mode flags.
- [ ] Feedback latency is below 30 seconds.
- [ ] Manual platform evidence is recorded for Web, iOS, and Android.
- [ ] `nyquist_compliant: true` is set in frontmatter.

**Approval:** pending
