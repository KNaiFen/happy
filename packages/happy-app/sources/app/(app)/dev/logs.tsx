import * as React from 'react';
import { View, Text, FlatList, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { log, MAX_APP_LOG_ENTRIES } from '@/log';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Item } from '@/components/Item';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import {
    MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS,
} from '@/sync/syncV4Diagnostics';
import { appSyncV4Diagnostics } from '@/sync/syncV4Diagnostics.mmkv';

type LogView = 'console' | 'syncV4';

function LogsScreen() {
    const [view, setView] = React.useState<LogView>('console');
    const [logs, setLogs] = React.useState<string[]>([]);
    const [syncV4Records, setSyncV4Records] = React.useState<ReturnType<
        typeof appSyncV4Diagnostics.records
    >>([]);
    const [syncV4Stats, setSyncV4Stats] = React.useState(() => appSyncV4Diagnostics.stats());
    const flatListRef = React.useRef<FlatList>(null);

    // Subscribe to log changes
    React.useEffect(() => {
        // Add some sample logs if empty (for demo purposes)
        if (log.getCount() === 0) {
            log.log('Logger initialized');
            log.log('Sample debug message');
            log.log('Application started successfully');
        }

        // Initial load
        setLogs(log.getLogs());

        // Subscribe to changes
        const unsubscribe = log.onChange(() => {
            setLogs(log.getLogs());
        });

        return unsubscribe;
    }, []);

    React.useEffect(() => {
        if (view !== 'syncV4') return;
        let refreshTimer: ReturnType<typeof setTimeout> | null = null;
        const refresh = () => {
            setSyncV4Records(appSyncV4Diagnostics.records());
            setSyncV4Stats(appSyncV4Diagnostics.stats());
        };
        refresh();
        const unsubscribe = appSyncV4Diagnostics.onChange(() => {
            if (refreshTimer) return;
            refreshTimer = setTimeout(() => {
                refreshTimer = null;
                refresh();
            }, 250);
        });
        return () => {
            unsubscribe();
            if (refreshTimer) clearTimeout(refreshTimer);
        };
    }, [view]);

    const visibleEntries = React.useMemo(
        () => view === 'console'
            ? logs
            : syncV4Records.map((record) => JSON.stringify(record)),
        [logs, syncV4Records, view],
    );
    const hasActionableEntries = view === 'console'
        ? visibleEntries.length > 0
        : syncV4Stats.count > 0
            || syncV4Stats.droppedRecords > 0
            || syncV4Stats.invalidRecords > 0
            || syncV4Stats.writeFailures > 0
            || syncV4Stats.listenerFailures > 0;

    // Auto-scroll to bottom when new logs arrive
    React.useEffect(() => {
        if (visibleEntries.length === 0) return;
        const timer = setTimeout(() => {
            flatListRef.current?.scrollToEnd({ animated: false });
        }, 100);
        return () => clearTimeout(timer);
    }, [visibleEntries.length, view]);

    const handleClear = async () => {
        const confirmed = await Modal.confirm(
            view === 'console' ? 'Clear Console Logs' : 'Clear Sync v4 Diagnostics',
            `Clear all ${view === 'console' ? 'console logs' : 'Sync v4 diagnostic records'}?`,
            { confirmText: 'Clear', destructive: true }
        );
        if (confirmed) {
            if (view === 'console') {
                log.clear();
            } else {
                appSyncV4Diagnostics.clear();
            }
        }
    };

    const handleCopyAll = async () => {
        if (!hasActionableEntries) {
            Modal.alert('No Logs', 'There are no logs to copy');
            return;
        }

        const allLogs = view === 'syncV4'
            ? appSyncV4Diagnostics.exportJsonl()
            : visibleEntries.join('\n');
        await Clipboard.setStringAsync(allLogs);
        Modal.alert(
            'Copied',
            `${view === 'syncV4' ? syncV4Records.length + 1 : visibleEntries.length} entries copied to clipboard`,
        );
    };

    const handleAddTestLog = () => {
        const timestamp = new Date().toLocaleTimeString();
        log.log(`Test log entry at ${timestamp}`);
    };

    const renderLogItem = ({ item, index }: { item: string; index: number }) => (
        <View style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: '#F0F0F0'
        }}>
            <Text style={{
                fontFamily: 'IBMPlexMono-Regular',
                fontSize: 12,
                color: '#333',
                lineHeight: 16
            }}>
                {item}
            </Text>
        </View>
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#F5F5F5' }}>
            {/* Header with actions */}
            <ItemList>
                <View style={{
                    flexDirection: 'row',
                    marginHorizontal: 16,
                    marginTop: 12,
                    padding: 3,
                    borderRadius: 6,
                    backgroundColor: '#E5E5EA',
                }}>
                    {([
                        ['console', `Console (${logs.length})`],
                        ['syncV4', `Sync v4 (${syncV4Stats.count})`],
                    ] as const).map(([value, label]) => (
                        <Pressable
                            key={value}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: view === value }}
                            onPress={() => setView(value)}
                            style={{
                                flex: 1,
                                minHeight: 36,
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 4,
                                backgroundColor: view === value ? '#FFFFFF' : 'transparent',
                            }}
                        >
                            <Text style={{
                                fontSize: 14,
                                fontWeight: '600',
                                color: view === value ? '#111111' : '#6D6D72',
                            }}>
                                {label}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                <ItemGroup
                    title={view === 'console' ? 'Console Logs' : 'Sync v4 Diagnostics'}
                    footer={view === 'console'
                        ? `Stored locally and capped at ${MAX_APP_LOG_ENTRIES.toLocaleString()} entries.`
                        : `Persistent ring: ${syncV4Records.length}/${MAX_APP_SYNC_V4_DIAGNOSTIC_RECORDS}; dropped ${syncV4Stats.droppedRecords}; invalid ${syncV4Stats.invalidRecords}; write failures ${syncV4Stats.writeFailures}; listener failures ${syncV4Stats.listenerFailures}.`}
                >
                    {view === 'console' && (
                        <Item
                            title="Add Test Log"
                            icon={<Ionicons name="add-circle-outline" size={24} color="#34C759" />}
                            onPress={handleAddTestLog}
                        />
                    )}
                    <Item 
                        title={view === 'console' ? 'Copy Console Logs' : 'Copy Sync v4 Diagnostics'}
                        icon={<Ionicons name="copy-outline" size={24} color="#007AFF" />}
                        onPress={handleCopyAll}
                        disabled={!hasActionableEntries}
                    />
                    <Item 
                        title={view === 'console' ? 'Clear Console Logs' : 'Clear Sync v4 Diagnostics'}
                        icon={<Ionicons name="trash-outline" size={24} color="#FF3B30" />}
                        onPress={handleClear}
                        disabled={!hasActionableEntries}
                        destructive={true}
                    />
                </ItemGroup>
            </ItemList>

            {/* Logs display */}
            <View style={{ flex: 1, backgroundColor: '#FFFFFF', margin: 16, borderRadius: 8 }}>
                {visibleEntries.length === 0 ? (
                    <View style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        padding: 32
                    }}>
                        <Ionicons name="document-text-outline" size={48} color="#C0C0C0" />
                        <Text style={{
                            fontSize: 16,
                            color: '#999',
                            marginTop: 16,
                            textAlign: 'center'
                        }}>
                            No {view === 'console' ? 'console logs' : 'Sync v4 diagnostics'} yet
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: '#C0C0C0',
                            marginTop: 8,
                            textAlign: 'center'
                        }}>
                            {view === 'console'
                                ? 'Logs will appear here as they are generated'
                                : 'Diagnostic records will appear when a Codex v4 session syncs'}
                        </Text>
                    </View>
                ) : (
                    <FlatList
                        ref={flatListRef}
                        data={visibleEntries}
                        renderItem={renderLogItem}
                        keyExtractor={(item, index) => index.toString()}
                        style={{ flex: 1 }}
                        contentContainerStyle={{ paddingVertical: 8 }}
                        showsVerticalScrollIndicator={true}
                    />
                )}
            </View>
        </View>
    );
}

export default React.memo(LogsScreen);
