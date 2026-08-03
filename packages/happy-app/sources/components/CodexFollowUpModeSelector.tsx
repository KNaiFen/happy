import type { CodexV4FollowUpMode } from '@/sync/codexV4Commands';
import { t } from '@/text';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export const CodexFollowUpModeSelector = React.memo(function CodexFollowUpModeSelector(props: {
    value: CodexV4FollowUpMode;
    canSteer: boolean;
    onChange: (value: CodexV4FollowUpMode) => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View
            accessibilityRole="tablist"
            style={styles.container}
        >
            <ModeButton
                label={t('session.followUpQueue')}
                selected={props.value === 'queue'}
                onPress={() => props.onChange('queue')}
                activeColor={theme.colors.button.primary.background}
            />
            <ModeButton
                label={t('session.followUpSteer')}
                selected={props.value === 'steer'}
                disabled={!props.canSteer}
                onPress={() => props.onChange('steer')}
                activeColor={theme.colors.button.primary.background}
            />
        </View>
    );
});

function ModeButton(props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    activeColor: string;
    onPress: () => void;
}) {
    return (
        <Pressable
            accessibilityRole="tab"
            accessibilityLabel={props.label}
            accessibilityState={{ selected: props.selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.option,
                props.selected && styles.optionSelected,
                pressed && !props.disabled && styles.optionPressed,
                props.disabled && styles.optionDisabled,
            ]}
        >
            <Text style={[
                styles.label,
                props.selected && { color: props.activeColor },
            ]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        alignSelf: 'flex-end',
        height: 34,
        flexDirection: 'row',
        alignItems: 'stretch',
        padding: 2,
        marginBottom: 6,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    option: {
        minWidth: 64,
        height: 28,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 5,
    },
    optionSelected: {
        backgroundColor: theme.colors.surface,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    optionDisabled: {
        opacity: 0.4,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 17,
        fontWeight: '600',
    },
}));
