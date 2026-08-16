import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AnchoredActionMenu } from './AnchoredActionMenu';
import type { AnchoredActionMenuItem } from './AnchoredActionMenu';
import type { AnchoredMenuRect } from './anchoredActionMenuPlacement';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';
import { orderSettingsMenuGroups, shouldCloseSettingsMenu } from './settingsMenuPolicy';
import { claimSettingsMenu, releaseSettingsMenu } from './settingsMenuCoordinator';

const styles = StyleSheet.create({
    fill: StyleSheet.absoluteFillObject,
    triggerContent: {
        minWidth: 0,
    },
});

export function NativeSettingsMenu({
    groups,
    children,
    style,
    accessibilityLabel,
    testID,
    flat = false,
    preferredGroupKey,
}: NativeSettingsMenuProps) {
    const triggerRef = React.useRef<View>(null);
    const menuToken = React.useRef<object>({}).current;
    const measureRequest = React.useRef(0);
    const [anchor, setAnchor] = React.useState<AnchoredMenuRect | null>(null);
    const orderedGroups = React.useMemo(
        () => orderSettingsMenuGroups(groups, preferredGroupKey),
        [groups, preferredGroupKey],
    );
    const triggerLabel = accessibilityLabel ?? orderedGroups.map((group) => group.label).join(', ');
    const closeMenu = React.useCallback(() => {
        measureRequest.current += 1;
        setAnchor(null);
        releaseSettingsMenu(menuToken);
    }, [menuToken]);
    React.useEffect(() => () => releaseSettingsMenu(menuToken), [menuToken]);
    const openMenu = React.useCallback(() => {
        if (!claimSettingsMenu(menuToken, closeMenu)) return;
        const request = ++measureRequest.current;
        const trigger = triggerRef.current;
        if (!trigger) {
            closeMenu();
            return;
        }
        trigger.measureInWindow((x, y, width, height) => {
            if (request !== measureRequest.current || width <= 0 || height <= 0) {
                releaseSettingsMenu(menuToken);
                return;
            }
            setAnchor({ x, y, width, height });
        });
    }, [closeMenu, menuToken]);
    const items = React.useMemo<readonly AnchoredActionMenuItem[]>(() => (
        orderedGroups.flatMap((group) => [
            ...(!flat && orderedGroups.length > 1 ? [{
                id: `${group.key}-section`,
                kind: 'section' as const,
                label: group.label,
            }] : []),
            ...group.options.map((option) => ({
                id: `${group.key}-${option.key}`,
                icon: (option.key === group.selectedKey ? 'checkmark' : 'ellipse-outline') as AnchoredActionMenuItem['icon'],
                label: option.label,
                disabled: option.disabled,
                selected: option.key === group.selectedKey,
                onPress: () => {
                    group.onSelect(option.key);
                    if (shouldCloseSettingsMenu(group)) closeMenu();
                },
            })),
        ])
    ), [closeMenu, flat, orderedGroups]);

    return (
        <View style={style}>
            <View pointerEvents="none" style={styles.triggerContent}>{children}</View>
            <Pressable
                ref={triggerRef}
                testID={testID}
                onPress={openMenu}
                style={styles.fill}
                accessibilityRole="button"
                accessibilityLabel={triggerLabel}
                accessibilityState={{ expanded: anchor !== null }}
            />
            <AnchoredActionMenu
                anchor={anchor}
                glassEnabled={false}
                items={items}
                onClose={closeMenu}
                preferAbove
                testID={testID ? `${testID}-options` : undefined}
                visible={anchor !== null}
            />
        </View>
    );
}
