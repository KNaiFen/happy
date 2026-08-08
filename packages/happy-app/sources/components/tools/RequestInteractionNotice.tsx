import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { CodexRequestInteraction } from '@/sync/typesMessage';
import { t } from '@/text';
import type { RequestResponseLocalFailure } from './requestInteractionUi';

export const RequestInteractionNotice = React.memo(function RequestInteractionNotice(props: {
    interaction: CodexRequestInteraction | undefined;
    localFailure?: RequestResponseLocalFailure | null;
}) {
    const { theme } = useUnistyles();
    const content = noticeContent(props.interaction, props.localFailure ?? null);
    if (!content) return null;
    return (
        <View style={styles.container} accessibilityRole="text">
            <Ionicons
                name={content.warning ? 'alert-circle-outline' : 'time-outline'}
                size={17}
                color={content.warning ? theme.colors.warning : theme.colors.textSecondary}
            />
            <View style={styles.textContainer}>
                <Text style={[styles.message, content.warning && styles.warning]}>{content.message}</Text>
                {content.detail ? <Text style={styles.detail} selectable>{content.detail}</Text> : null}
            </View>
        </View>
    );
});

function noticeContent(
    interaction: CodexRequestInteraction | undefined,
    localFailure: RequestResponseLocalFailure | null,
): { message: string; detail: string | null; warning: boolean } | null {
    if (localFailure === 'outcomeUnknown') {
        return { message: t('tools.requestResponse.outcomeUnknown'), detail: null, warning: true };
    }
    if (localFailure === 'retryable') {
        return { message: t('tools.requestResponse.submitFailed'), detail: null, warning: true };
    }
    switch (interaction?.state) {
        case 'submitting':
            return { message: t('tools.requestResponse.submitting'), detail: null, warning: false };
        case 'awaitingConfirmation':
            return { message: t('tools.requestResponse.awaitingConfirmation'), detail: null, warning: false };
        case 'retryableError':
            return {
                message: t('tools.requestResponse.submitFailed'),
                detail: interaction.error,
                warning: true,
            };
        case 'outcomeUnknown':
            return {
                message: t('tools.requestResponse.outcomeUnknown'),
                detail: interaction.error,
                warning: true,
            };
        case 'unavailable':
            return {
                message: t('tools.requestResponse.unavailable'),
                detail: interaction.error,
                warning: true,
            };
        case 'awaitingInput':
        case 'settled':
        case undefined:
            return null;
    }
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 7,
        paddingVertical: 5,
    },
    textContainer: {
        flex: 1,
        gap: 3,
    },
    message: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    warning: {
        color: theme.colors.warning,
    },
    detail: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
    },
}));
