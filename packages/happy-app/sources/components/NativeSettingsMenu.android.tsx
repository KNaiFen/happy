import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AnchoredActionMenu } from './AnchoredActionMenu';
import type { AnchoredActionMenuItem } from './AnchoredActionMenu';
import type { AnchoredMenuRect } from './anchoredActionMenuPlacement';
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
    const triggerRef = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<AnchoredMenuRect | null>(null);
    const triggerLabel = accessibilityLabel ?? groups.map((group) => group.label).join(', ');
    const closeMenu = React.useCallback(() => setAnchor(null), []);
    const openMenu = React.useCallback(() => {
        triggerRef.current?.measureInWindow((x, y, width, height) => {
            if (width <= 0 || height <= 0) return;
            setAnchor({ x, y, width, height });
        });
    }, []);
    const items = React.useMemo<readonly AnchoredActionMenuItem[]>(() => (
        groups.flatMap((group) => group.options.map((option) => ({
            id: `${group.key}-${option.key}`,
            icon: option.key === group.selectedKey ? 'checkmark' : 'ellipse-outline',
            label: `${flat ? '' : `${group.label}: `}${option.label}`,
            selected: option.key === group.selectedKey,
            onPress: () => {
                closeMenu();
                group.onSelect(option.key);
            },
        })))
    ), [closeMenu, flat, groups]);

    return (
        <View style={style}>
            <Pressable
                ref={triggerRef}
                testID={testID}
                onPress={openMenu}
                style={styles.fill}
                accessibilityRole="button"
                accessibilityLabel={triggerLabel}
                accessibilityState={{ expanded: anchor !== null }}
            >
                {children}
            </Pressable>
            <AnchoredActionMenu
                anchor={anchor}
                glassEnabled={false}
                items={items}
                onClose={closeMenu}
                testID={testID ? `${testID}-options` : undefined}
                visible={anchor !== null}
            />
        </View>
    );
}
