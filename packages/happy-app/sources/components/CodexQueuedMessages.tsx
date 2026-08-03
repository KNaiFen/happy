import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import {
    sessionSteerCodexQueuedMessage,
    sessionUpdateCodexQueuedMessage,
} from '@/sync/ops';
import type { CodexV4QueuedMessage } from '@/sync/codexV4Projection';
import { t } from '@/text';
import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type QueueAction = { id: string; type: 'edit' | 'steer' } | null;

export const CodexQueuedMessages = React.memo(function CodexQueuedMessages(props: {
    sessionId: string;
    messages: CodexV4QueuedMessage[];
    canSteer: boolean;
}) {
    const { theme } = useUnistyles();
    const [action, setAction] = React.useState<QueueAction>(null);

    const handleEdit = React.useCallback(async (message: CodexV4QueuedMessage) => {
        if (action) return;
        const nextText = await Modal.prompt(t('session.queuedMessageEdit'), undefined, {
            defaultValue: message.text,
            cancelText: t('common.cancel'),
            confirmText: t('common.save'),
        });
        const text = nextText?.trim();
        if (!text || text === message.text) return;

        setAction({ id: message.id, type: 'edit' });
        try {
            await sessionUpdateCodexQueuedMessage(props.sessionId, message.id, text);
        } catch (error) {
            console.error('Failed to update queued Codex message', error);
            Modal.alert(t('common.error'), t('session.queuedMessageActionFailed'));
        } finally {
            setAction(null);
        }
    }, [action, props.sessionId]);

    const handleSteer = React.useCallback(async (message: CodexV4QueuedMessage) => {
        if (action || !props.canSteer) return;
        setAction({ id: message.id, type: 'steer' });
        try {
            await sessionSteerCodexQueuedMessage(props.sessionId, message.id);
        } catch (error) {
            console.error('Failed to steer queued Codex message', error);
            Modal.alert(t('common.error'), t('session.queuedMessageActionFailed'));
        } finally {
            setAction(null);
        }
    }, [action, props.canSteer, props.sessionId]);

    if (props.messages.length === 0) return null;

    const editLabel = t('session.queuedMessageEdit');
    const steerLabel = t('session.queuedMessageSteer');
    return (
        <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={props.messages.length > 3}
            keyboardShouldPersistTaps="handled"
        >
            {props.messages.map((message) => {
                const editing = action?.id === message.id && action.type === 'edit';
                const steering = action?.id === message.id && action.type === 'steer';
                const editDisabled = action !== null;
                const steerDisabled = action !== null || !props.canSteer;
                return (
                    <View key={message.id} style={styles.message}>
                        <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail">
                            {message.text.trim() ? message.text : t('session.queuedAttachment')}
                        </Text>
                        <View style={styles.actions}>
                            <Pressable
                                ref={(node) => {
                                    if (Platform.OS === 'web' && node) {
                                        (node as unknown as { title: string }).title = editLabel;
                                    }
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={editLabel}
                                accessibilityState={{ disabled: editDisabled }}
                                disabled={editDisabled}
                                onPress={() => void handleEdit(message)}
                                hitSlop={8}
                                style={({ pressed }) => [
                                    styles.actionButton,
                                    pressed && styles.actionButtonPressed,
                                    editDisabled && styles.actionButtonDisabled,
                                ]}
                            >
                                {editing ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons name="pencil-outline" size={17} color={theme.colors.textSecondary} />
                                )}
                            </Pressable>
                            <Pressable
                                ref={(node) => {
                                    if (Platform.OS === 'web' && node) {
                                        (node as unknown as { title: string }).title = steerLabel;
                                    }
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={steerLabel}
                                accessibilityState={{ disabled: steerDisabled }}
                                disabled={steerDisabled}
                                onPress={() => void handleSteer(message)}
                                hitSlop={8}
                                style={({ pressed }) => [
                                    styles.actionButton,
                                    pressed && styles.actionButtonPressed,
                                    steerDisabled && styles.actionButtonDisabled,
                                ]}
                            >
                                {steering ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons name="return-down-forward-outline" size={18} color={theme.colors.button.primary.background} />
                                )}
                            </Pressable>
                        </View>
                    </View>
                );
            })}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    scroll: {
        maxHeight: 184,
        marginBottom: 6,
    },
    content: {
        gap: 6,
        paddingTop: 2,
        paddingHorizontal: 1,
        paddingBottom: 2,
    },
    message: {
        height: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 8,
        paddingVertical: 7,
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
        gap: 2,
    },
    actionButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    actionButtonDisabled: {
        opacity: 0.4,
    },
}));
