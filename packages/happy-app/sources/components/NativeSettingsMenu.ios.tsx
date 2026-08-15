import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Host, HStack, Menu, Spacer } from '@expo/ui/swift-ui';
import {
    accessibilityLabel as accessibilityLabelModifier,
    contentShape,
    disabled,
    frame,
    menuActionDismissBehavior,
    opacity,
    shapes,
    tint,
} from '@expo/ui/swift-ui/modifiers';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';
import { orderSettingsMenuGroups } from './settingsMenuPolicy';
import { useUnistyles } from 'react-native-unistyles';

const systemImage = (name: string) => (
    name as React.ComponentProps<typeof Button>['systemImage']
);

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    trigger: {
        flex: 1,
        minWidth: 0,
    },
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

export function NativeSettingsMenu({
    groups,
    children,
    style,
    accessibilityLabel,
    flat = false,
    preferredGroupKey,
}: NativeSettingsMenuProps) {
    const { theme } = useUnistyles();
    const orderedGroups = orderSettingsMenuGroups(groups, preferredGroupKey);
    const triggerLabel = accessibilityLabel ?? orderedGroups.map((group) => group.label).join(', ');
    return (
        <View style={[styles.container, style]}>
            <View pointerEvents="none" style={styles.trigger}>{children}</View>
            <Host colorScheme={theme.dark ? 'dark' : 'light'} style={styles.host}>
                <Menu
                    modifiers={[tint(theme.colors.text)]}
                    label={(
                        <HStack modifiers={[
                            frame({ maxWidth: 10000, minHeight: 40 }),
                            contentShape(shapes.rectangle()),
                            accessibilityLabelModifier(triggerLabel),
                            opacity(0.01),
                        ]}>
                            <Spacer minLength={8} />
                        </HStack>
                    )}
                >
                    {flat ? orderedGroups.flatMap((group) => (
                        group.options.map((option) => (
                            <Button
                                key={`${group.key}:${option.key}`}
                                label={option.label}
                                modifiers={[
                                    ...(option.disabled ? [disabled(true)] : []),
                                    menuActionDismissBehavior(group.keepOpenOnSelect ? 'disabled' : 'automatic'),
                                ]}
                                systemImage={option.key === group.selectedKey ? systemImage('checkmark') : undefined}
                                onPress={() => group.onSelect(option.key)}
                            />
                        ))
                    )) : orderedGroups.map((group) => (
                        <Menu
                            key={group.key}
                            label={group.label}
                            systemImage={group.systemImage}
                            modifiers={[tint(theme.colors.text)]}
                        >
                            {group.options.map((option) => (
                                <Button
                                    key={option.key}
                                    label={option.label}
                                    modifiers={[
                                        ...(option.disabled ? [disabled(true)] : []),
                                        menuActionDismissBehavior(group.keepOpenOnSelect ? 'disabled' : 'automatic'),
                                    ]}
                                    systemImage={option.key === group.selectedKey ? systemImage('checkmark') : undefined}
                                    onPress={() => group.onSelect(option.key)}
                                />
                            ))}
                        </Menu>
                    ))}
                </Menu>
            </Host>
        </View>
    );
}
