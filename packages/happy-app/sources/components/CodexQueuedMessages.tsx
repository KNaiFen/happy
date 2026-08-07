import { Ionicons } from '@expo/vector-icons';
import { AnchoredActionMenu } from '@/components/AnchoredActionMenu';
import type { AnchoredActionMenuItem } from '@/components/AnchoredActionMenu';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { Modal } from '@/modal';
import {
    sessionCancelCodexQueuedMessage,
    sessionSteerCodexQueuedMessage,
    sessionUpdateCodexQueuedMessage,
} from '@/sync/ops';
import type { CodexV4QueuedMessage } from '@/sync/codexV4Projection';
import { t } from '@/text';
import * as React from 'react';
import {
    ActivityIndicator,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
    useWindowDimensions,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AnchoredMenuRect } from './anchoredActionMenuPlacement';
import {
    CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET,
    CODEX_QUEUED_MESSAGE_JOIN_DEPTH,
    CODEX_QUEUED_MESSAGE_HEIGHT,
    CODEX_QUEUED_MESSAGE_OVERLAP,
    CODEX_QUEUED_MESSAGE_TOP_RADIUS,
    resolveCodexQueuedMessageStack,
    resolveCodexQueuedMessageStackHeight,
    resolveCodexQueuedMessageStackInitialOffset,
} from './codexQueuedMessageStack';

type QueueActionKind = 'edit' | 'steer' | 'remove';
type QueueAction = { commandId: string; type: QueueActionKind } | null;
type Measurable = Pick<React.ComponentRef<typeof Pressable>, 'measureInWindow'>;
type PressableRef = React.ComponentRef<typeof Pressable>;

function setWebTitle(node: unknown, title: string) {
    if (Platform.OS === 'web' && node) {
        (node as { title: string }).title = title;
    }
}

function QueueActionButton(props: {
    accessibilityLabel: string;
    busy?: boolean;
    buttonRef?: React.Ref<PressableRef>;
    children: React.ReactNode;
    disabled: boolean;
    onPress: () => void;
    steer?: boolean;
    testID?: string;
}) {
    return (
        <Pressable
            ref={props.buttonRef}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ disabled: props.disabled, busy: props.busy }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={[
                styles.actionHitTarget,
                props.steer && styles.steerHitTarget,
            ]}
            testID={props.testID}
        >
            {({ pressed }) => (
                <View
                    pointerEvents="none"
                    style={[
                        styles.actionVisual,
                        props.steer && styles.steerVisual,
                        pressed && !props.disabled && styles.actionButtonPressed,
                        props.disabled && styles.actionButtonDisabled,
                    ]}
                >
                    {props.children}
                </View>
            )}
        </Pressable>
    );
}

export const CodexQueuedMessages = React.memo(function CodexQueuedMessages(props: {
    sessionId: string;
    messages: CodexV4QueuedMessage[];
    canSteer: boolean;
    glassEnabled?: boolean;
}) {
    const { theme } = useUnistyles();
    const keyboard = useKeyboardState();
    const safeArea = useSafeAreaInsets();
    const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
    const [action, setAction] = React.useState<QueueAction>(null);
    const [menuMessage, setMenuMessage] = React.useState<CodexV4QueuedMessage | null>(null);
    const [menuAnchor, setMenuAnchor] = React.useState<AnchoredMenuRect | null>(null);
    const scrollRef = React.useRef<ScrollView>(null);
    const moreButtonRefs = React.useRef<Record<string, Measurable | null>>({});
    const menuMeasurementToken = React.useRef(0);

    const performAction = React.useCallback(async (
        message: CodexV4QueuedMessage,
        type: QueueActionKind,
    ) => {
        if (action || (type === 'steer' && !props.canSteer)) return;
        setAction({ commandId: message.commandId, type });
        try {
            if (type === 'edit') {
                const nextText = await Modal.prompt(t('session.queuedMessageEdit'), undefined, {
                    defaultValue: message.text,
                    cancelText: t('common.cancel'),
                    confirmText: t('common.save'),
                });
                const text = nextText?.trim();
                if (!text || text === message.text) return;
                await sessionUpdateCodexQueuedMessage(props.sessionId, message.id, text);
                return;
            }

            if (type === 'steer') {
                await sessionSteerCodexQueuedMessage(props.sessionId, message.id);
                return;
            }

            await sessionCancelCodexQueuedMessage(props.sessionId, message.id);
        } catch {
            // The command projection is authoritative. Avoid attaching a mutable
            // provider or message payload to a UI diagnostic while it refreshes.
            console.error('Queued Codex message action failed');
            Modal.alert(t('common.error'), t('session.queuedMessageActionFailed'));
        } finally {
            setAction(null);
        }
    }, [action, props.canSteer, props.sessionId]);

    const closeMenu = React.useCallback(() => {
        menuMeasurementToken.current += 1;
        setMenuAnchor(null);
        setMenuMessage(null);
    }, []);

    const measureMenuAnchor = React.useCallback((message: CodexV4QueuedMessage, open = false) => {
        const node = moreButtonRefs.current[message.commandId];
        if (!node) return;
        const measurementToken = open
            ? ++menuMeasurementToken.current
            : menuMeasurementToken.current;
        node.measureInWindow((x, y, width, height) => {
            if (measurementToken !== menuMeasurementToken.current) return;
            if (width <= 0 || height <= 0) return;
            setMenuAnchor({ x, y, width, height });
            if (open) setMenuMessage(message);
        });
    }, []);

    const openMenu = React.useCallback((message: CodexV4QueuedMessage) => {
        if (action) return;
        measureMenuAnchor(message, true);
    }, [action, measureMenuAnchor]);

    const selectMenuAction = React.useCallback((type: QueueActionKind) => {
        if (!menuMessage) return;
        const message = menuMessage;
        closeMenu();
        void performAction(message, type);
    }, [closeMenu, menuMessage, performAction]);

    const refreshMenuAnchor = React.useCallback(() => {
        if (!menuMessage) return;
        measureMenuAnchor(menuMessage);
    }, [measureMenuAnchor, menuMessage]);

    React.useEffect(() => {
        if (!menuMessage) return;
        const frameId = requestAnimationFrame(refreshMenuAnchor);
        return () => cancelAnimationFrame(frameId);
    }, [
        keyboard.height,
        keyboard.isVisible,
        menuMessage,
        refreshMenuAnchor,
        safeArea.bottom,
        safeArea.left,
        safeArea.right,
        safeArea.top,
        viewportHeight,
        viewportWidth,
    ]);

    const editLabel = t('session.queuedMessageEdit');
    const steerLabel = t('session.queuedMessageSteer');
    const steerCompactLabel = t('session.queuedMessageSteerCompact');
    const removeLabel = t('session.queuedMessageRemove');
    const moreLabel = t('session.queuedMessageMore');
    const stackedMessages = resolveCodexQueuedMessageStack(props.messages);
    const scrollHeight = resolveCodexQueuedMessageStackHeight(props.messages.length);
    const initialScrollOffset = resolveCodexQueuedMessageStackInitialOffset(props.messages.length);
    const anchorEarliestMessages = React.useCallback(() => {
        scrollRef.current?.scrollTo({ y: initialScrollOffset, animated: false });
    }, [initialScrollOffset]);
    const menuItems = React.useMemo<AnchoredActionMenuItem[]>(() => {
        if (!menuMessage) return [];
        const disabled = action !== null;
        return [
            {
                id: 'edit',
                icon: 'pencil-outline',
                label: editLabel,
                disabled,
                onPress: () => selectMenuAction('edit'),
            },
            {
                id: 'steer',
                icon: 'return-down-forward-outline',
                label: steerLabel,
                disabled: disabled || !props.canSteer,
                onPress: () => selectMenuAction('steer'),
            },
            {
                id: 'remove',
                icon: 'trash-outline',
                label: removeLabel,
                disabled,
                destructive: true,
                onPress: () => selectMenuAction('remove'),
            },
        ];
    }, [action, editLabel, menuMessage, props.canSteer, removeLabel, selectMenuAction, steerLabel]);

    if (props.messages.length === 0) return null;

    return (
        <>
            <View
                onLayout={refreshMenuAnchor}
                style={[styles.stack, { height: scrollHeight }]}
                testID="codex-queued-message-dock"
            >
                <View
                    pointerEvents="none"
                    style={[
                        styles.composerJoinBridge,
                        props.glassEnabled && styles.composerJoinBridgeGlass,
                    ]}
                />
                <MobileGlassSurface
                    enabled={props.glassEnabled}
                    nativeEffect
                    intensity={86}
                    pointerEvents="none"
                    style={[
                        styles.stackBackfill,
                        props.glassEnabled && styles.stackBackfillGlass,
                    ]}
                />
                <ScrollView
                    ref={scrollRef}
                    style={styles.scroll}
                    contentContainerStyle={styles.content}
                    contentOffset={{ x: 0, y: initialScrollOffset }}
                    onContentSizeChange={() => {
                        anchorEarliestMessages();
                        refreshMenuAnchor();
                    }}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                >
                    {stackedMessages.map((layer) => {
                        const message = layer.message;
                        const activeType = action?.commandId === message.commandId ? action.type : null;
                        const disabled = action !== null;
                        const steerDisabled = disabled || !props.canSteer;
                        const preview = message.text.trim() || t('session.queuedAttachment');
                        return (
                            <View
                                key={message.commandId}
                                style={[
                                    styles.message,
                                    layer.overlapsPrevious && styles.messageOverlap,
                                    { zIndex: layer.zIndex },
                                ]}
                                testID={`codex-queued-message-${message.commandId}`}
                            >
                                <View
                                    pointerEvents="none"
                                    style={[
                                        styles.messageCap,
                                        props.glassEnabled && styles.messageCapGlass,
                                    ]}
                                />
                                <View style={styles.messageContent}>
                                    <Ionicons
                                        color={theme.colors.textSecondary}
                                        name="list-outline"
                                        size={14}
                                    />
                                    <Text
                                        accessibilityLabel={preview}
                                        style={styles.text}
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                    >
                                        {preview}
                                    </Text>
                                    <View style={styles.actions}>
                                        <QueueActionButton
                                            accessibilityLabel={steerLabel}
                                            busy={activeType === 'steer'}
                                            buttonRef={(node) => setWebTitle(node, steerLabel)}
                                            disabled={steerDisabled}
                                            onPress={() => void performAction(message, 'steer')}
                                            steer
                                        >
                                            {activeType === 'steer' ? (
                                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                            ) : (
                                                <>
                                                    <Ionicons name="return-down-forward-outline" size={15} color={theme.colors.textSecondary} />
                                                    <Text numberOfLines={1} style={styles.steerLabel}>{steerCompactLabel}</Text>
                                                </>
                                            )}
                                        </QueueActionButton>
                                        <QueueActionButton
                                            accessibilityLabel={removeLabel}
                                            busy={activeType === 'remove'}
                                            buttonRef={(node) => setWebTitle(node, removeLabel)}
                                            disabled={disabled}
                                            onPress={() => void performAction(message, 'remove')}
                                        >
                                            {activeType === 'remove' ? (
                                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                            ) : (
                                                <Ionicons name="trash-outline" size={16} color={theme.colors.textSecondary} />
                                            )}
                                        </QueueActionButton>
                                        <QueueActionButton
                                            accessibilityLabel={moreLabel}
                                            buttonRef={(node) => {
                                                moreButtonRefs.current[message.commandId] = node;
                                                setWebTitle(node, moreLabel);
                                            }}
                                            disabled={disabled}
                                            onPress={() => openMenu(message)}
                                            testID={`codex-queued-message-more-${message.commandId}`}
                                        >
                                            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                                        </QueueActionButton>
                                    </View>
                                </View>
                            </View>
                        );
                    })}
                </ScrollView>
            </View>
            <AnchoredActionMenu
                anchor={menuAnchor}
                dismissLabel={t('common.cancel')}
                glassEnabled={props.glassEnabled === true}
                items={menuItems}
                onClose={closeMenu}
                testID="codex-queued-message-menu"
                visible={menuMessage !== null}
            />
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    stack: {
        position: 'relative',
        overflow: 'visible',
    },
    scroll: {
        flexGrow: 0,
        zIndex: 1,
    },
    content: {
        paddingTop: 0,
    },
    stackBackfill: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: -CODEX_QUEUED_MESSAGE_JOIN_DEPTH,
        left: 0,
        borderTopLeftRadius: CODEX_QUEUED_MESSAGE_TOP_RADIUS,
        borderTopRightRadius: CODEX_QUEUED_MESSAGE_TOP_RADIUS,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
        zIndex: 0,
    },
    stackBackfillGlass: {
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
        borderColor: theme.colors.glass.border,
    },
    composerJoinBridge: {
        position: 'absolute',
        top: '100%',
        right: -CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET,
        left: -CODEX_QUEUED_MESSAGE_DOCK_HORIZONTAL_INSET,
        height: CODEX_QUEUED_MESSAGE_JOIN_DEPTH,
        backgroundColor: theme.colors.input.background,
        zIndex: 0,
    },
    composerJoinBridgeGlass: {
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
    },
    message: {
        height: CODEX_QUEUED_MESSAGE_HEIGHT,
        position: 'relative',
    },
    messageOverlap: {
        marginTop: -CODEX_QUEUED_MESSAGE_OVERLAP,
    },
    messageCap: {
        position: 'absolute',
        top: 0,
        right: 0,
        left: 0,
        height: CODEX_QUEUED_MESSAGE_TOP_RADIUS,
        borderTopLeftRadius: CODEX_QUEUED_MESSAGE_TOP_RADIUS,
        borderTopRightRadius: CODEX_QUEUED_MESSAGE_TOP_RADIUS,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
    },
    messageCapGlass: {
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
    },
    messageContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingLeft: 14,
        paddingRight: 4,
        paddingTop: CODEX_QUEUED_MESSAGE_OVERLAP,
    },
    text: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 0,
    },
    actionHitTarget: {
        width: 44,
        height: CODEX_QUEUED_MESSAGE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    steerHitTarget: {
        width: 68,
    },
    actionVisual: {
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    steerVisual: {
        width: 68,
        flexDirection: 'row',
        gap: 3,
        paddingHorizontal: 5,
    },
    steerLabel: {
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    actionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    actionButtonDisabled: {
        opacity: 0.42,
    },
}));
