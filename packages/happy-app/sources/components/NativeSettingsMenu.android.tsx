import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { Pressable, StyleSheet } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

const styles = StyleSheet.create({
    trigger: {
        flex: 1,
        width: '100%',
        height: '100%',
    },
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
        <DropdownMenu
            expanded={expanded}
            onDismissRequest={() => setExpanded(false)}
            style={style}
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
            <DropdownMenu.Trigger>
                <Pressable
                    testID={testID}
                    onPress={() => setExpanded(true)}
                    style={styles.trigger}
                    accessibilityRole="button"
                    accessibilityLabel={triggerLabel}
                    accessibilityState={{ expanded }}
                >
                    {children}
                </Pressable>
            </DropdownMenu.Trigger>
        </DropdownMenu>
    );
}
