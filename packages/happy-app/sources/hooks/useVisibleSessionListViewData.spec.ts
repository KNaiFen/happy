import { describe, expect, it } from 'vitest';

import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
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
    { type: 'session', session: row('archived-today', false, 2_000) },
    { type: 'header', title: 'Yesterday' },
    { type: 'session', session: row('archived-yesterday', false, 1_000) },
];

describe('buildVisibleSessionListViewData', () => {
    it('keeps recoverable history visible while hiding archived sessions', () => {
        expect(buildVisibleSessionListViewData(data, true)).toEqual([
            data[0],
            { type: 'archive-toggle', hidden: true },
            data[1],
            data[2],
        ]);
    });

    it('shows archived sessions with their non-empty date groups', () => {
        expect(buildVisibleSessionListViewData(data, false)).toEqual([
            data[0],
            { type: 'archive-toggle', hidden: false },
            ...data.slice(1),
        ]);
    });

    it('does not render an archive toggle when only recoverable history exists', () => {
        expect(buildVisibleSessionListViewData([
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('recoverable', false, null) },
        ], true)).toEqual([
            { type: 'header', title: 'Today' },
            { type: 'session', session: row('recoverable', false, null) },
        ]);
    });
});
