import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { fillMaxSize } from '@expo/ui/jetpack-compose/modifiers';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

const styles = StyleSheet.create({
    fill: StyleSheet.absoluteFillObject,
});

export function NativeSettingsMenu({
    groups,
    children,
    style,
    accessibilityLabel,
    testID,
    flat = false,
}: NativeSettingsMenuProps) {
    const [expanded, setExpanded] = React.useState(false);
    const triggerLabel = accessibilityLabel ?? groups.map((group) => group.label).join(', ');

    return (
        <View style={style}>
            <DropdownMenu
                expanded={expanded}
                onDismissRequest={() => setExpanded(false)}
                style={styles.fill}
                modifiers={[fillMaxSize()]}
            >
                <DropdownMenu.Items>
                    {groups.flatMap((group) => group.options.map((option) => (
                        <DropdownMenuItem
                            key={`${group.key}:${option.key}`}
                            onClick={() => {
                                setExpanded(false);
                                group.onSelect(option.key);
                            }}
                        >
                            <DropdownMenuItem.Text>
                                {`${flat ? '' : `${group.label}: `}${option.key === group.selectedKey ? '✓ ' : ''}${option.label}`}
                            </DropdownMenuItem.Text>
                        </DropdownMenuItem>
                    )))}
                </DropdownMenu.Items>
            </DropdownMenu>
            <Pressable
                testID={testID}
                onPress={() => setExpanded(true)}
                style={styles.fill}
                accessibilityRole="button"
                accessibilityLabel={triggerLabel}
                accessibilityState={{ expanded }}
            >
                {children}
            </Pressable>
        </View>
    );
}
