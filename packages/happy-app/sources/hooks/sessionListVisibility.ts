import type { SessionListViewItem } from '@/sync/storage';

export function buildVisibleSessionListViewData(
    data: SessionListViewItem[],
    hideArchivedSessions: boolean,
): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    const activeGroup = data.find((item) => item.type === 'active-sessions');
    if (activeGroup) result.push(activeGroup);

    const recoverable = selectHistoryItems(
        data,
        (item) => !item.session.active && item.session.archivedAt === null,
    );
    result.push(...recoverable);

    const archived = selectHistoryItems(
        data,
        (item) => !item.session.active && item.session.archivedAt !== null,
    );
    if (archived.length > 0) {
        result.push({ type: 'archive-toggle', hidden: hideArchivedSessions });
        if (!hideArchivedSessions) result.push(...archived);
    }

    return result;
}

function selectHistoryItems(
    data: SessionListViewItem[],
    include: (item: Extract<SessionListViewItem, { type: 'session' }>) => boolean,
): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    let pendingHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingProject: Extract<SessionListViewItem, { type: 'project-group' }> | null = null;
    for (const item of data) {
        if (item.type === 'active-sessions' || item.type === 'archive-toggle') {
            continue;
        }

        if (item.type === 'header') {
            pendingHeader = item;
            pendingProject = null;
            continue;
        }
        if (item.type === 'project-group') {
            pendingProject = item;
            continue;
        }
        if (item.type === 'session' && include(item)) {
            if (pendingHeader) result.push(pendingHeader);
            if (pendingProject) result.push(pendingProject);
            result.push(item);
            pendingHeader = null;
            pendingProject = null;
        }
    }

    return result;
}
