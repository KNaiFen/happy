import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { buildVisibleSessionListViewData } from './sessionListVisibility';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideArchivedSessions = useSetting('hideArchivedSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        return buildVisibleSessionListViewData(data, hideArchivedSessions);
    }, [data, hideArchivedSessions]);
}
