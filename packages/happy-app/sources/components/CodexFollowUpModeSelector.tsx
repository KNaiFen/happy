import type { CodexV4FollowUpMode } from '@/sync/codexV4Commands';
import { t } from '@/text';
import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export const CodexFollowUpModeSelector = React.memo(function CodexFollowUpModeSelector(props: {
    value: CodexV4FollowUpMode;
    canSteer: boolean;
    onChange: (value: CodexV4FollowUpMode) => void;
}) {
    const { theme } = useUnistyles();
    const webRadioRefs = React.useRef<Array<HTMLDivElement | null>>([]);
    const focusMode = React.useCallback((mode: CodexV4FollowUpMode) => {
        props.onChange(mode);
        if (Platform.OS === 'web') {
            requestAnimationFrame(() => webRadioRefs.current[mode === 'queue' ? 0 : 1]?.focus());
        }
    }, [props.onChange]);
    const moveFocus = React.useCallback((direction: 'previous' | 'next') => {
        if (!props.canSteer) return;
        const nextMode = props.value === 'queue' ? 'steer' : 'queue';
        // With two enabled choices, either arrow direction selects the other one.
        void direction;
        focusMode(nextMode);
    }, [focusMode, props.canSteer, props.value]);
    const queueTabIndex = props.value === 'queue' || !props.canSteer ? 0 : -1;
    const steerTabIndex = props.value === 'steer' && props.canSteer ? 0 : -1;
    return (
        <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('session.followUpMode')}
            style={styles.container}
        >
            <ModeButton
                label={t('session.followUpQueue')}
                selected={props.value === 'queue'}
                onPress={() => focusMode('queue')}
                activeColor={theme.colors.button.primary.background}
                selectedBackgroundColor={theme.colors.surface}
                tabIndex={queueTabIndex}
                webRef={(node) => { webRadioRefs.current[0] = node; }}
                onDirectionalKey={moveFocus}
            />
            <ModeButton
                label={t('session.followUpSteer')}
                selected={props.value === 'steer'}
                disabled={!props.canSteer}
                onPress={() => focusMode('steer')}
                activeColor={theme.colors.button.primary.background}
                selectedBackgroundColor={theme.colors.surface}
                tabIndex={steerTabIndex}
                webRef={(node) => { webRadioRefs.current[1] = node; }}
                onDirectionalKey={moveFocus}
            />
        </View>
    );
});

function ModeButton(props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    activeColor: string;
    selectedBackgroundColor: string;
    tabIndex: 0 | -1;
    webRef: (node: HTMLDivElement | null) => void;
    onDirectionalKey: (direction: 'previous' | 'next') => void;
    onPress: () => void;
}) {
    const optionStyle = (pressed: boolean) => [
        styles.option,
        props.selected && styles.optionSelected,
        pressed && !props.disabled && styles.optionPressed,
        props.disabled && styles.optionDisabled,
    ];

    if (Platform.OS === 'web') {
        return (
            <div
                role="radio"
                aria-label={props.label}
                aria-checked={props.selected}
                aria-disabled={props.disabled === true}
                ref={props.webRef}
                tabIndex={props.disabled ? -1 : props.tabIndex}
                onClick={props.disabled ? undefined : props.onPress}
                onKeyDown={(event) => {
                    const key = event.key;
                    if (key === 'ArrowLeft' || key === 'ArrowUp') {
                        event.preventDefault();
                        props.onDirectionalKey('previous');
                        return;
                    }
                    if (key === 'ArrowRight' || key === 'ArrowDown') {
                        event.preventDefault();
                        props.onDirectionalKey('next');
                        return;
                    }
                    if (!props.disabled && (key === 'Enter' || key === ' ' || key === 'Spacebar')) {
                        event.preventDefault();
                        props.onPress();
                    }
                }}
                style={{
                    display: 'flex',
                    flex: '1 1 0%',
                    minWidth: 0,
                    height: 44,
                    padding: '0 6px',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxSizing: 'border-box',
                    borderRadius: 5,
                    cursor: props.disabled ? 'default' : 'pointer',
                    opacity: props.disabled ? 0.4 : 1,
                    backgroundColor: props.selected ? props.selectedBackgroundColor : 'transparent',
                }}
            >
                <Text style={[
                    styles.label,
                    props.selected && { color: props.activeColor },
                ]} numberOfLines={1}>
                    {props.label}
                </Text>
            </div>
        );
    }

    return (
        <Pressable
            accessibilityRole="radio"
            accessibilityLabel={props.label}
            accessibilityState={{ checked: props.selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed }) => optionStyle(pressed)}
        >
            <Text style={[
                styles.label,
                props.selected && { color: props.activeColor },
            ]} numberOfLines={1}>
                {props.label}
            </Text>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        alignSelf: 'flex-end',
        width: 184,
        height: 44,
        flexDirection: 'row',
        alignItems: 'stretch',
        padding: 0,
        marginBottom: 4,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    option: {
        flex: 1,
        minWidth: 0,
        height: 44,
        paddingHorizontal: 6,
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
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
        fontWeight: '600',
    },
}));
