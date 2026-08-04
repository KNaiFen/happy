import type { SessionListViewItem } from '@/sync/storage';

export function buildVisibleSessionListViewData(
    data: SessionListViewItem[],
    hideArchivedSessions: boolean,
): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    const activeGroup = data.find((item) => item.type === 'active-sessions');
    if (activeGroup) result.push(activeGroup);

    const hasArchived = data.some((item) => (
        item.type === 'session' && item.session.archivedAt !== null
    ));
    if (hasArchived) {
        result.push({ type: 'archive-toggle', hidden: hideArchivedSessions });
    }

    let pendingContext: SessionListViewItem[] = [];
    for (const item of data) {
        if (item.type === 'active-sessions' || item.type === 'archive-toggle') {
            continue;
        }

        if (item.type === 'header') {
            pendingContext = [item];
            continue;
        }
        if (item.type === 'project-group') {
            pendingContext = [
                ...pendingContext.filter((pending) => pending.type === 'header'),
                item,
            ];
            continue;
        }
        if (item.type === 'session') {
            if (item.session.active || (hideArchivedSessions && item.session.archivedAt !== null)) {
                continue;
            }
            result.push(...pendingContext, item);
            pendingContext = [];
        }
    }

    return result;
}
