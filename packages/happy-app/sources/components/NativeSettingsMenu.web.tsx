import * as React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { NativeSettingsMenuGroup, NativeSettingsMenuProps } from './NativeSettingsMenu';
import { orderSettingsMenuGroups, shouldCloseSettingsMenu } from './settingsMenuPolicy';
import { claimSettingsMenu, releaseSettingsMenu } from './settingsMenuCoordinator';
import { resolveAnchoredMenuPlacement, type AnchoredMenuRect } from './anchoredActionMenuPlacement';

const MENU_WIDTH = 288;
const MENU_ITEM_HEIGHT = 44;
const MENU_SECTION_HEIGHT = 30;
const MENU_MARGIN = 8;
const MENU_GAP = 6;
const createPortal = (require('react-dom') as {
    createPortal: (children: React.ReactNode, container: Element) => React.ReactPortal;
}).createPortal;

type WebMenuItemPressableProps = Omit<React.ComponentProps<typeof Pressable>, 'onKeyDown' | 'onPointerDown' | 'role'> & {
    'aria-checked'?: boolean;
    'aria-disabled'?: boolean;
    onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
    onPointerDown?: (event: { preventDefault: () => void }) => void;
    role?: 'menuitemradio';
};

const WebMenuItemPressable = Pressable as unknown as React.ComponentType<WebMenuItemPressableProps>;

function menuHeight(groups: readonly NativeSettingsMenuGroup[], flat: boolean): number {
    return groups.reduce(
        (height, group) => height
            + (flat || groups.length === 1 ? 0 : MENU_SECTION_HEIGHT)
            + group.options.length * MENU_ITEM_HEIGHT,
        0,
    );
}

export function NativeSettingsMenu({
    groups,
    children,
    style,
    accessibilityLabel,
    testID,
    flat = false,
    preferredGroupKey,
}: NativeSettingsMenuProps) {
    const { theme } = useUnistyles();
    const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
    const triggerRef = React.useRef<View>(null);
    const menuRef = React.useRef<View>(null);
    const menuToken = React.useRef<object>({}).current;
    const measureRequest = React.useRef(0);
    const [anchor, setAnchor] = React.useState<AnchoredMenuRect | null>(null);
    const [mounted, setMounted] = React.useState(false);
    const closeStarted = React.useRef(false);
    const restoreTriggerFocus = React.useRef(false);
    const lastTriggerPointerDown = React.useRef(0);
    const focusMenuOnOpen = React.useRef(false);
    const [reducedMotion, setReducedMotion] = React.useState(() => (
        typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ));
    const progress = useSharedValue(0);
    const orderedGroups = React.useMemo(
        () => orderSettingsMenuGroups(groups, preferredGroupKey),
        [groups, preferredGroupKey],
    );
    const triggerLabel = accessibilityLabel ?? orderedGroups.map((group) => group.label).join(', ');
    const generatedId = React.useId().replace(/:/g, '');
    const menuId = testID ? `${testID}-popover` : `settings-menu-${generatedId}`;
    const triggerId = `${menuId}-trigger`;
    const preserveInputFocus = React.useCallback((event: { preventDefault: () => void }) => {
        const active = typeof document === 'undefined' ? null : document.activeElement;
        if (active instanceof HTMLInputElement
            || active instanceof HTMLTextAreaElement
            || (active instanceof HTMLElement && active.isContentEditable)) {
            event.preventDefault();
        }
    }, []);
    const handleTriggerPointerDown = React.useCallback((event: { preventDefault: () => void }) => {
        lastTriggerPointerDown.current = Date.now();
        preserveInputFocus(event);
    }, [preserveInputFocus]);

    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(query.matches);
        update();
        query.addEventListener?.('change', update);
        return () => query.removeEventListener?.('change', update);
    }, []);

    const measure = React.useCallback(() => {
        triggerRef.current?.measureInWindow((x, y, width, height) => {
            if (width <= 0 || height <= 0) return;
            setAnchor({ x, y, width, height });
        });
    }, []);

    const finishClose = React.useCallback(() => {
        closeStarted.current = false;
        setMounted(false);
        setAnchor(null);
        releaseSettingsMenu(menuToken);
        if (restoreTriggerFocus.current && typeof document !== 'undefined') {
            restoreTriggerFocus.current = false;
            document.getElementById(triggerId)?.focus();
        }
    }, [menuToken, triggerId]);

    const closeMenu = React.useCallback(() => {
        if (closeStarted.current) return;
        const menu = menuRef.current as unknown as HTMLElement | null;
        restoreTriggerFocus.current = restoreTriggerFocus.current || (
            typeof document !== 'undefined'
            && menu?.contains(document.activeElement) === true
        );
        closeStarted.current = true;
        measureRequest.current += 1;
        progress.value = withTiming(0, {
            duration: reducedMotion ? 0 : 140,
            easing: Easing.in(Easing.cubic),
        }, (finished) => {
            if (!finished) return;
            runOnJS(finishClose)();
        });
    }, [finishClose, progress, reducedMotion]);

    React.useEffect(() => () => releaseSettingsMenu(menuToken), [menuToken]);

    React.useEffect(() => {
        if (!mounted) return;
        progress.value = withTiming(1, {
            duration: reducedMotion ? 0 : 180,
            easing: Easing.out(Easing.cubic),
        });
    }, [mounted, progress, reducedMotion]);

    React.useEffect(() => {
        if (!mounted || typeof window === 'undefined') return;
        const reposition = () => measure();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            restoreTriggerFocus.current = event.target instanceof HTMLElement
                && event.target.closest('[role="menu"]') !== null;
            closeMenu();
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [closeMenu, measure, mounted]);

    const openMenu = React.useCallback((event?: { preventDefault?: () => void }) => {
        event?.preventDefault?.();
        if (mounted) {
            closeMenu();
            return;
        }
        if (!claimSettingsMenu(menuToken, closeMenu)) return;
        focusMenuOnOpen.current = Date.now() - lastTriggerPointerDown.current > 1000;
        const request = ++measureRequest.current;
        setMounted(true);
        triggerRef.current?.measureInWindow((x, y, width, height) => {
            if (request !== measureRequest.current || width <= 0 || height <= 0) {
                closeMenu();
                return;
            }
            setAnchor({ x, y, width, height });
        });
    }, [closeMenu, menuToken, mounted]);

    const animatedMenuStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [
            { translateY: (1 - progress.value) * 8 },
            { scale: 0.98 + progress.value * 0.02 },
        ],
    }));

    const placement = anchor ? resolveAnchoredMenuPlacement({
        anchor,
        viewport: { width: viewportWidth, height: viewportHeight },
        menu: { width: MENU_WIDTH, height: menuHeight(orderedGroups, flat) },
        preferAbove: true,
        margin: MENU_MARGIN,
        gap: MENU_GAP,
    }) : null;

    React.useEffect(() => {
        if (!mounted || !placement || !focusMenuOnOpen.current) return;
        focusMenuOnOpen.current = false;
        const menu = menuRef.current as unknown as HTMLElement | null;
        const selected = menu?.querySelector<HTMLElement>(
            '[role="menuitemradio"][aria-checked="true"]:not([aria-disabled="true"])',
        );
        const firstAvailable = menu?.querySelector<HTMLElement>(
            '[role="menuitemradio"]:not([aria-disabled="true"])',
        );
        (selected ?? firstAvailable)?.focus();
    }, [mounted, placement]);

    const selectOption = React.useCallback((group: NativeSettingsMenuGroup, key: string) => {
        group.onSelect(key);
        if (shouldCloseSettingsMenu(group)) closeMenu();
    }, [closeMenu]);

    const handleMenuItemKeyDown = React.useCallback((
        event: React.KeyboardEvent<HTMLElement>,
        group: NativeSettingsMenuGroup,
        option: NativeSettingsMenuGroup['options'][number],
    ) => {
        if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            if (!option.disabled) selectOption(group, option.key);
            return;
        }

        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();

        const menu = menuRef.current as unknown as HTMLElement | null;
        const items = Array.from(
            menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])') ?? [],
        );
        if (items.length === 0) return;

        const currentIndex = items.indexOf(event.currentTarget);
        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? items.length - 1
                : event.key === 'ArrowUp'
                    ? (currentIndex - 1 + items.length) % items.length
                    : (currentIndex + 1) % items.length;
        items[nextIndex]?.focus();
    }, [selectOption]);

    const layer = mounted && placement ? (
        <View style={styles.layer} pointerEvents="box-none">
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                onPress={closeMenu}
                style={styles.dismiss}
                testID={testID ? `${testID}-dismiss` : undefined}
                {...{ onPointerDown: preserveInputFocus, tabIndex: -1 }}
            />
            <Animated.View
                ref={menuRef}
                accessibilityLabel={triggerLabel}
                accessibilityRole="menu"
                accessibilityViewIsModal
                nativeID={menuId}
                style={[
                    styles.menu,
                    {
                        left: placement.left,
                        top: placement.top,
                        width: placement.width,
                        maxHeight: placement.maxHeight,
                        backgroundColor: theme.colors.input.background,
                        borderColor: theme.colors.divider,
                    },
                    animatedMenuStyle,
                ]}
                testID={testID}
            >
                <View style={styles.scroll}>
                    {orderedGroups.map((group, groupIndex) => (
                        <React.Fragment key={group.key}>
                            {!flat && orderedGroups.length > 1 && (
                                <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
                                    {group.label}
                                </Text>
                            )}
                            {group.options.map((option, optionIndex) => {
                                const selected = option.key === group.selectedKey;
                                return (
                                    <WebMenuItemPressable
                                        key={`${group.key}:${option.key}`}
                                        accessibilityRole="menuitem"
                                        accessibilityLabel={option.label}
                                        accessibilityState={{ checked: selected, disabled: option.disabled }}
                                        disabled={option.disabled}
                                        onKeyDown={(event) => handleMenuItemKeyDown(event, group, option)}
                                        onPress={() => selectOption(group, option.key)}
                                        style={({ pressed }) => [
                                            styles.item,
                                            pressed && !option.disabled && { backgroundColor: theme.colors.surfacePressed },
                                            option.disabled && styles.disabled,
                                        ]}
                                        testID={testID ? `${testID}-${group.key}-${option.key}` : undefined}
                                        aria-checked={selected}
                                        aria-disabled={option.disabled || undefined}
                                        onPointerDown={preserveInputFocus}
                                        role="menuitemradio"
                                    >
                                        <Text style={[styles.itemLabel, { color: theme.colors.text }]}>
                                            {option.label}
                                        </Text>
                                        {selected && (
                                            <Text
                                                accessibilityElementsHidden
                                                style={[styles.checkmark, { color: theme.colors.text }]}
                                                {...{ 'aria-hidden': true }}
                                            >
                                                ✓
                                            </Text>
                                        )}
                                    </WebMenuItemPressable>
                                );
                            })}
                            {!flat && groupIndex < orderedGroups.length - 1 && (
                                <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />
                            )}
                        </React.Fragment>
                    ))}
                </View>
            </Animated.View>
        </View>
    ) : null;

    return (
        <View style={[styles.container, style]}>
            <View ref={triggerRef} pointerEvents="none" style={styles.triggerContent}>{children}</View>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={triggerLabel}
                accessibilityState={{ expanded: mounted, disabled: orderedGroups.length === 0 }}
                disabled={orderedGroups.length === 0}
                onPress={openMenu}
                nativeID={triggerId}
                style={styles.fill}
                testID={testID}
                {...{
                    'aria-controls': mounted ? menuId : undefined,
                    'aria-expanded': mounted,
                    'aria-haspopup': 'menu',
                    onPointerDown: handleTriggerPointerDown,
                }}
            />
            {typeof document !== 'undefined' && layer ? createPortal(layer, document.body) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { position: 'relative' },
    fill: { ...StyleSheet.absoluteFillObject },
    triggerContent: { minWidth: 0 },
    layer: {
        position: 'fixed' as 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1000,
    },
    dismiss: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    menu: {
        position: 'absolute',
        borderWidth: 1,
        borderRadius: 12,
        overflow: 'auto' as 'hidden',
        shadowColor: '#000000',
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
    },
    scroll: { minHeight: 0 },
    sectionLabel: {
        minHeight: MENU_SECTION_HEIGHT,
        paddingHorizontal: 14,
        paddingTop: 8,
        paddingBottom: 4,
        fontSize: 11,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    item: {
        minHeight: MENU_ITEM_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        gap: 10,
    },
    itemLabel: {
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    checkmark: { fontSize: 16, lineHeight: 20 },
    divider: { height: 1, marginHorizontal: 12 },
    disabled: { opacity: 0.45 },
});
