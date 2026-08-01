import * as React from 'react';
import {
    ActivityIndicator,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MobileGlassSurface } from './MobileGlass';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import {
    listCodexThreads,
    openCodexThread,
    scanCodexThreadBindings,
    type CodexOpenThreadDefaults,
    type CodexThreadBinding,
    type CodexThreadHistoryRow,
} from '@/sync/codexThreadHistory';

export interface CodexResumeThreadSheetProps {
    machineId: string;
    directory: string;
    defaults: CodexOpenThreadDefaults;
    onClose?: () => void;
}

export const CodexResumeThreadSheet = React.memo(function CodexResumeThreadSheet({
    machineId,
    directory,
    defaults,
    onClose,
}: CodexResumeThreadSheetProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const windowSize = useWindowDimensions();
    const frame = React.useMemo(() => getDuplicateSheetFrame(windowSize), [windowSize.width, windowSize.height]);
    const [query, setQuery] = React.useState('');
    const [debouncedQuery, setDebouncedQuery] = React.useState('');
    const [threads, setThreads] = React.useState<CodexThreadHistoryRow[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [listLoading, setListLoading] = React.useState(true);
    const [moreLoading, setMoreLoading] = React.useState(false);
    const [listError, setListError] = React.useState<string | null>(null);
    const [bindings, setBindings] = React.useState<Map<string, CodexThreadBinding> | null>(null);
    const [bindingError, setBindingError] = React.useState<string | null>(null);
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [opening, setOpening] = React.useState(false);
    const listGeneration = React.useRef(0);
    const openingRef = React.useRef(false);
    const moreLoadingRef = React.useRef(false);

    React.useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
        return () => clearTimeout(timer);
    }, [query]);

    React.useEffect(() => {
        let cancelled = false;
        setBindings(null);
        setBindingError(null);
        void scanCodexThreadBindings(machineId).then((result) => {
            if (!cancelled) setBindings(result.byThreadId);
        }).catch((error) => {
            if (!cancelled) {
                setBindingError(error instanceof Error ? error.message : t('machine.resumeBindingScanFailed'));
            }
        });
        return () => { cancelled = true; };
    }, [machineId]);

    React.useEffect(() => {
        const generation = ++listGeneration.current;
        setListLoading(true);
        setListError(null);
        setSelectedId(null);
        void listCodexThreads({
            machineId,
            directory,
            searchTerm: debouncedQuery,
        }).then((result) => {
            if (generation !== listGeneration.current) return;
            setThreads(result.threads);
            setNextCursor(result.nextCursor);
        }).catch((error) => {
            if (generation !== listGeneration.current) return;
            setThreads([]);
            setNextCursor(null);
            setListError(error instanceof Error ? error.message : t('machine.resumeThreadListFailed'));
        }).finally(() => {
            if (generation === listGeneration.current) setListLoading(false);
        });
    }, [debouncedQuery, directory, machineId]);

    const loadMore = React.useCallback(async () => {
        if (!nextCursor || moreLoadingRef.current) return;
        const generation = listGeneration.current;
        moreLoadingRef.current = true;
        setMoreLoading(true);
        setListError(null);
        try {
            const result = await listCodexThreads({
                machineId,
                directory,
                cursor: nextCursor,
                searchTerm: debouncedQuery,
            });
            if (generation !== listGeneration.current) return;
            setThreads((current) => {
                const seen = new Set(current.map((thread) => thread.threadId));
                return [...current, ...result.threads.filter((thread) => !seen.has(thread.threadId))];
            });
            setNextCursor(result.nextCursor);
        } catch (error) {
            if (generation === listGeneration.current) {
                setListError(error instanceof Error ? error.message : t('machine.resumeThreadListFailed'));
            }
        } finally {
            moreLoadingRef.current = false;
            if (generation === listGeneration.current) setMoreLoading(false);
        }
    }, [debouncedQuery, directory, machineId, nextCursor]);

    const selected = threads.find((thread) => thread.threadId === selectedId) ?? null;
    const selectedBinding = selected ? bindings?.get(selected.threadId) : undefined;
    const selectedBlockReason = selected
        ? getBlockedReason(selected, selectedBinding)
        : null;
    const canConfirm = Boolean(
        selected
        && bindings
        && !bindingError
        && !selectedBlockReason
        && !opening,
    );

    const confirm = React.useCallback(async () => {
        if (!selected || !bindings || selectedBlockReason || openingRef.current) return;
        openingRef.current = true;
        setOpening(true);
        try {
            const result = await openCodexThread({
                machineId,
                directory,
                thread: selected,
                binding: bindings.get(selected.threadId),
                defaults,
            });
            if (result.type !== 'success') {
                Modal.alert(
                    t('common.error'),
                    result.type === 'resumeMaterialRequired'
                        ? t('machine.resumeMaterialUnavailable')
                        : result.errorMessage,
                );
                return;
            }
            try {
                await sync.refreshSessions();
            } catch (error) {
                if (!bindings.has(selected.threadId)) {
                    Modal.alert(
                        t('common.error'),
                        error instanceof Error ? error.message : t('machine.resumeSessionRefreshFailed'),
                    );
                    return;
                }
                // Existing sessions were hydrated by the binding scan before the open RPC.
            }
            onClose?.();
            router.replace(`/session/${result.sessionId}`);
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('machine.resumeThreadOpenFailed'),
            );
        } finally {
            openingRef.current = false;
            setOpening(false);
        }
    }, [bindings, defaults, directory, machineId, onClose, router, selected, selectedBlockReason]);

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={[styles.sheet, frame]}
        >
            <View style={styles.header}>
                <Text style={styles.title}>{t('machine.resumeThreadTitle')}</Text>
                <Text style={styles.subtitle}>{directory}</Text>
                <View style={styles.searchContainer}>
                    <Ionicons name="search" size={17} color={theme.colors.textSecondary} />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('machine.resumeThreadSearch')}
                        placeholderTextColor={theme.colors.textSecondary}
                        style={styles.searchInput}
                        accessibilityLabel={t('machine.resumeThreadSearch')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={512}
                    />
                </View>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                {bindingError ? (
                    <StatusMessage icon="warning-outline" text={bindingError} />
                ) : bindings === null ? (
                    <StatusMessage loading text={t('machine.resumeCheckingBindings')} />
                ) : null}

                {listLoading ? (
                    <StatusMessage loading text={t('common.loading')} />
                ) : listError && threads.length === 0 ? (
                    <StatusMessage icon="alert-circle-outline" text={listError} />
                ) : threads.length === 0 ? (
                    <StatusMessage icon="time-outline" text={t('machine.resumeThreadEmpty')} />
                ) : (
                    threads.map((thread) => {
                        const binding = bindings?.get(thread.threadId);
                        const blockedReason = getBlockedReason(thread, binding);
                        const selected = selectedId === thread.threadId;
                        return (
                            <Pressable
                                key={thread.threadId}
                                testID={`codex-resume-thread-${thread.threadId}`}
                                onPress={() => setSelectedId(thread.threadId)}
                                style={({ pressed }) => [
                                    styles.row,
                                    selected && styles.rowSelected,
                                    pressed && styles.rowPressed,
                                ]}
                                accessibilityRole="radio"
                                accessibilityState={{ selected }}
                            >
                                <View style={styles.rowHeader}>
                                    <Text style={styles.rowTitle} numberOfLines={2}>
                                        {thread.title || t('machine.untitledSession')}
                                    </Text>
                                    <Ionicons
                                        name={selected ? 'radio-button-on' : 'radio-button-off'}
                                        size={20}
                                        color={selected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                    />
                                </View>
                                {thread.preview && thread.preview !== thread.title ? (
                                    <Text style={styles.rowPreview} numberOfLines={2}>{thread.preview}</Text>
                                ) : null}
                                <View style={styles.rowMetaLine}>
                                    <Text style={styles.rowMeta}>{formatThreadMeta(thread)}</Text>
                                    <BindingLabel binding={binding} status={thread.status} />
                                </View>
                                {blockedReason ? <Text style={styles.blockedText}>{blockedReason}</Text> : null}
                            </Pressable>
                        );
                    })
                )}

                {listError && threads.length > 0 ? (
                    <StatusMessage icon="alert-circle-outline" text={listError} />
                ) : null}

                {nextCursor ? (
                    <Pressable
                        onPress={() => { void loadMore(); }}
                        disabled={moreLoading}
                        style={({ pressed }) => [styles.loadMore, pressed && styles.rowPressed]}
                    >
                        {moreLoading ? <ActivityIndicator size="small" /> : <Text style={styles.loadMoreText}>{t('machine.resumeLoadMore')}</Text>}
                    </Pressable>
                ) : null}
            </ScrollView>

            <View style={styles.actions}>
                <Pressable onPress={onClose} style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}>
                    <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    testID={canConfirm ? 'codex-resume-confirm' : 'codex-resume-confirm-disabled'}
                    onPress={() => { void confirm(); }}
                    disabled={!canConfirm}
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        !canConfirm && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    {opening ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} /> : (
                        <Text style={styles.buttonPrimaryText}>{t('machine.resumeThreadConfirm')}</Text>
                    )}
                </Pressable>
            </View>
        </MobileGlassSurface>
    );
});

function getBlockedReason(thread: CodexThreadHistoryRow, binding: CodexThreadBinding | undefined): string | null {
    if (binding?.type === 'duplicate') return t('machine.resumeDuplicateBinding');
    if (binding?.type === 'bound' && binding.legacy) return t('machine.resumeLegacyBlocked');
    if (!binding && thread.status === 'active') return t('machine.resumeExternalActiveBlocked');
    return null;
}

function formatThreadMeta(thread: CodexThreadHistoryRow): string {
    return `${sourceLabel(thread.source)} · ${new Date(thread.recencyAt).toLocaleString()}`;
}

function sourceLabel(source: CodexThreadHistoryRow['source']): string {
    switch (source) {
        case 'cli': return t('machine.resumeSourceCli');
        case 'vscode': return t('machine.resumeSourceVscode');
        case 'exec': return t('machine.resumeSourceExec');
        case 'appServer': return t('machine.resumeSourceAppServer');
        default: return t('machine.resumeSourceUnknown');
    }
}

function BindingLabel({ binding, status }: {
    binding: CodexThreadBinding | undefined;
    status: CodexThreadHistoryRow['status'];
}) {
    let icon: React.ComponentProps<typeof Ionicons>['name'] = 'cloud-outline';
    let text = t('machine.resumeExternalThread');
    if (binding?.type === 'duplicate') {
        icon = 'warning-outline';
        text = t('machine.resumeDuplicate');
    } else if (binding?.type === 'bound') {
        icon = binding.active ? 'radio-outline' : 'archive-outline';
        text = binding.active ? t('machine.resumeHappyActive') : t('machine.resumeHappyInactive');
    } else if (status === 'active') {
        icon = 'pulse-outline';
        text = t('machine.resumeProviderActive');
    }
    return (
        <View style={styles.bindingLabel}>
            <Ionicons name={icon} size={13} style={styles.bindingIcon} />
            <Text style={styles.bindingText}>{text}</Text>
        </View>
    );
}

function StatusMessage({ loading, icon, text }: {
    loading?: boolean;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    text: string;
}) {
    return (
        <View style={styles.statusMessage}>
            {loading ? <ActivityIndicator size="small" /> : icon ? <Ionicons name={icon} size={20} style={styles.statusIcon} /> : null}
            <Text style={styles.statusText}>{text}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: { fontSize: 17, fontWeight: '600', color: theme.colors.text },
    subtitle: { marginTop: 4, fontSize: 12, color: theme.colors.textSecondary },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 40,
        marginTop: 14,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    searchInput: { flex: 1, minWidth: 0, paddingVertical: 8, fontSize: 14, color: theme.colors.text },
    list: { flexGrow: 0, flexShrink: 1, maxHeight: 470, minHeight: 180 },
    listContent: { paddingVertical: 6 },
    row: {
        paddingHorizontal: 20,
        paddingVertical: 13,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowSelected: { backgroundColor: theme.colors.surfaceHigh },
    rowPressed: { opacity: 0.72 },
    rowHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    rowTitle: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, fontWeight: '600', color: theme.colors.text },
    rowPreview: { marginTop: 5, fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    rowMetaLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 7 },
    rowMeta: { flexShrink: 1, fontSize: 11, color: theme.colors.textSecondary },
    bindingLabel: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    bindingIcon: { color: theme.colors.textSecondary },
    bindingText: { fontSize: 11, color: theme.colors.textSecondary },
    blockedText: { marginTop: 7, fontSize: 12, lineHeight: 17, color: theme.colors.warning ?? '#B45309' },
    statusMessage: { minHeight: 76, paddingHorizontal: 20, paddingVertical: 20, alignItems: 'center', justifyContent: 'center', gap: 8 },
    statusIcon: { color: theme.colors.textSecondary },
    statusText: { maxWidth: 440, textAlign: 'center', fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    loadMore: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    loadMoreText: { fontSize: 14, color: theme.colors.button.primary.background },
    actions: { flexDirection: 'row', gap: 8, padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    button: { flex: 1, minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    buttonPrimary: { backgroundColor: theme.colors.button.primary.background },
    buttonSecondary: { backgroundColor: theme.colors.surfaceHigh },
    buttonDisabled: { opacity: 0.4 },
    buttonPressed: { opacity: 0.72 },
    buttonPrimaryText: { color: theme.colors.button.primary.tint, fontSize: 15, fontWeight: '600' },
    buttonSecondaryText: { color: theme.colors.text, fontSize: 15, fontWeight: '500' },
}));
