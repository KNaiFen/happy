import { Ionicons } from '@expo/vector-icons';
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
    Modal as NativeModal,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type QueueActionKind = 'edit' | 'steer' | 'remove';
type QueueAction = { commandId: string; type: QueueActionKind } | null;

function setWebTitle(node: unknown, title: string) {
    if (Platform.OS === 'web' && node) {
        (node as { title: string }).title = title;
    }
}

export const CodexQueuedMessages = React.memo(function CodexQueuedMessages(props: {
    sessionId: string;
    messages: CodexV4QueuedMessage[];
    canSteer: boolean;
}) {
    const { theme } = useUnistyles();
    const [action, setAction] = React.useState<QueueAction>(null);
    const [menuMessage, setMenuMessage] = React.useState<CodexV4QueuedMessage | null>(null);

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

    const openMenu = React.useCallback((message: CodexV4QueuedMessage) => {
        if (!action) setMenuMessage(message);
    }, [action]);

    const selectMenuAction = React.useCallback((type: QueueActionKind) => {
        if (!menuMessage) return;
        const message = menuMessage;
        setMenuMessage(null);
        void performAction(message, type);
    }, [menuMessage, performAction]);

    if (props.messages.length === 0) return null;

    const editLabel = t('session.queuedMessageEdit');
    const steerLabel = t('session.queuedMessageSteer');
    const removeLabel = t('session.queuedMessageRemove');
    const moreLabel = t('session.queuedMessageMore');
    const visibleRows = Math.min(props.messages.length, 3);
    const scrollHeight = visibleRows * 48 + Math.max(0, visibleRows - 1) * 4 + 2;

    return (
        <>
            <ScrollView
                testID="codex-queued-message-dock"
                style={[styles.scroll, { height: scrollHeight }]}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={props.messages.length > 3}
                keyboardShouldPersistTaps="handled"
            >
                {props.messages.map((message) => {
                    const activeType = action?.commandId === message.commandId ? action.type : null;
                    const disabled = action !== null;
                    const steerDisabled = disabled || !props.canSteer;
                    const preview = message.text.trim() || t('session.queuedAttachment');
                    return (
                        <View key={message.commandId} style={styles.message} testID={`codex-queued-message-${message.commandId}`}>
                            <Text
                                accessibilityLabel={preview}
                                style={styles.text}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {preview}
                            </Text>
                            <View style={styles.actions}>
                                <Pressable
                                    ref={(node) => setWebTitle(node, steerLabel)}
                                    accessibilityRole="button"
                                    accessibilityLabel={steerLabel}
                                    accessibilityState={{ disabled: steerDisabled, busy: activeType === 'steer' }}
                                    disabled={steerDisabled}
                                    onPress={() => void performAction(message, 'steer')}
                                    style={({ pressed }) => [
                                        styles.actionButton,
                                        pressed && !steerDisabled && styles.actionButtonPressed,
                                        steerDisabled && styles.actionButtonDisabled,
                                    ]}
                                >
                                    {activeType === 'steer' ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : (
                                        <Ionicons name="return-down-forward-outline" size={18} color={theme.colors.button.primary.background} />
                                    )}
                                </Pressable>
                                <Pressable
                                    ref={(node) => setWebTitle(node, removeLabel)}
                                    accessibilityRole="button"
                                    accessibilityLabel={removeLabel}
                                    accessibilityState={{ disabled, busy: activeType === 'remove' }}
                                    disabled={disabled}
                                    onPress={() => void performAction(message, 'remove')}
                                    style={({ pressed }) => [
                                        styles.actionButton,
                                        pressed && !disabled && styles.actionButtonPressed,
                                        disabled && styles.actionButtonDisabled,
                                    ]}
                                >
                                    {activeType === 'remove' ? (
                                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                    ) : (
                                        <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
                                    )}
                                </Pressable>
                                <Pressable
                                    testID="codex-queued-message-more"
                                    ref={(node) => setWebTitle(node, moreLabel)}
                                    accessibilityRole="button"
                                    accessibilityLabel={moreLabel}
                                    accessibilityState={{ disabled }}
                                    disabled={disabled}
                                    onPress={() => openMenu(message)}
                                    style={({ pressed }) => [
                                        styles.actionButton,
                                        pressed && !disabled && styles.actionButtonPressed,
                                        disabled && styles.actionButtonDisabled,
                                    ]}
                                >
                                    <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.textSecondary} />
                                </Pressable>
                            </View>
                        </View>
                    );
                })}
            </ScrollView>

            <NativeModal
                transparent
                visible={menuMessage !== null}
                animationType="fade"
                onRequestClose={() => setMenuMessage(null)}
            >
                <View style={styles.menuLayer}>
                    <Pressable
                        testID="codex-queued-message-menu-dismiss"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        style={styles.menuBackdrop}
                        onPress={() => setMenuMessage(null)}
                    />
                    <View accessibilityViewIsModal style={styles.menuSurface}>
                        <MenuAction
                            icon="pencil-outline"
                            label={editLabel}
                            onPress={() => selectMenuAction('edit')}
                        />
                        <MenuAction
                            icon="return-down-forward-outline"
                            label={steerLabel}
                            disabled={!props.canSteer}
                            onPress={() => selectMenuAction('steer')}
                        />
                        <MenuAction
                            icon="trash-outline"
                            label={removeLabel}
                            destructive
                            onPress={() => selectMenuAction('remove')}
                        />
                    </View>
                </View>
            </NativeModal>
        </>
    );
});

function MenuAction(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    disabled?: boolean;
    destructive?: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.menuAction,
                pressed && !props.disabled && styles.menuActionPressed,
                props.disabled && styles.actionButtonDisabled,
            ]}
        >
            <Ionicons
                name={props.icon}
                size={19}
                color={props.destructive ? theme.colors.warningCritical : theme.colors.text}
            />
            <Text style={[
                styles.menuActionText,
                props.destructive && { color: theme.colors.warningCritical },
            ]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    scroll: {
        flexGrow: 0,
    },
    content: {
        gap: 4,
        paddingTop: 1,
        paddingBottom: 1,
    },
    message: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 12,
        paddingRight: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 5,
        elevation: 3,
    },
    text: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 19,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 1,
    },
    actionButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    actionButtonDisabled: {
        opacity: 0.42,
    },
    menuLayer: {
        flex: 1,
        justifyContent: 'flex-end',
        padding: 12,
    },
    menuBackdrop: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.24)',
    },
    menuSurface: {
        width: '100%',
        maxWidth: 320,
        alignSelf: 'flex-end',
        overflow: 'hidden',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 14,
        elevation: 8,
    },
    menuAction: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
    },
    menuActionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    menuActionText: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
    },
}));
