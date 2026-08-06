import { describe, expect, it } from 'vitest';

import type {
    ResumeEligibilityEntry,
    SessionListViewItem,
    SessionRowData,
} from '@/sync/storage';
import { buildVisibleSessionListViewData } from './sessionListVisibility';

function row(id: string, active: boolean, archivedAt: number | null): SessionRowData {
    return {
        id,
        name: id,
        subtitle: '/tmp/project',
        avatarId: id,
        flavor: 'codex',
        clientId: null,
        identityLine: null,
        providerKind: 'openai',
        modelName: null,
        activitySummary: null,
        state: active ? 'waiting' : 'disconnected',
        statusUnknown: false,
        ...(active ? {} : { activeAt: 1, createdAt: 1 }),
        hasDraft: false,
        active,
        archivedAt,
        machineId: 'machine-1',
        path: '/tmp/project',
        homeDir: '/tmp',
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: false,
    };
}

const data: SessionListViewItem[] = [
    { type: 'active-sessions', sessions: [row('active', true, null)] },
    { type: 'header', title: 'Today' },
    { type: 'session', session: row('recoverable', false, null) },
    { type: 'session', session: row('pending', false, null) },
    { type: 'session', session: row('ineligible', false, null) },
    { type: 'session', session: row('archived-today', false, 2_000) },
    { type: 'header', title: 'Yesterday' },
    { type: 'session', session: row('archived-yesterday', false, 1_000) },
];

const eligibility: Record<string, ResumeEligibilityEntry> = {
    recoverable: {
        fingerprint: 'recoverable',
        state: 'eligible',
        checkedAt: 1,
    },
    pending: {
        fingerprint: 'pending',
        state: 'checking',
        checkedAt: 1,
    },
    ineligible: {
        fingerprint: 'ineligible',
        state: 'ineligible',
        checkedAt: 1,
        reason: 'invalidBinding',
    },
};

describe('buildVisibleSessionListViewData', () => {
    it('keeps recoverable history visible while hiding archived sessions', () => {
        expect(buildVisibleSessionListViewData(data, true, eligibility)).toEqual([
            data[0],
            data[1],
            data[2],
            { type: 'resume-pending', sessions: [row('pending', false, null)] },
            { type: 'archive-toggle', hidden: true },
        ]);
    });

    it('shows archived sessions with their non-empty date groups', () => {
        expect(buildVisibleSessionListViewData(data, false, eligibility)).toEqual([
            data[0],
            data[1],
            data[2],
            { type: 'resume-pending', sessions: [row('pending', false, null)] },
            { type: 'archive-toggle', hidden: false },
            data[1],
            data[5],
            data[6],
            data[7],
        ]);
    });

    it('does not render an archive toggle when only recoverable history exists', () => {
        expect(buildVisibleSessionListViewData([
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('recoverable', false, null) },
        ], true, { recoverable: eligibility.recoverable })).toEqual([
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('recoverable', false, null) },
        ]);
    });

    it('keeps unchecked history in the pending group and hides terminal failures', () => {
        expect(buildVisibleSessionListViewData([
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('unchecked', false, null) },
            { type: 'session', session: row('terminal', false, null) },
        ], true, {
            terminal: {
                fingerprint: 'terminal',
                state: 'ineligible',
                checkedAt: 1,
                reason: 'threadUnavailable',
            },
        })).toEqual([
            { type: 'resume-pending', sessions: [row('unchecked', false, null)] },
        ]);
    });
});
