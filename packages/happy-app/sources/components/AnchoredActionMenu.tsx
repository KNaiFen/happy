import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Modal as NativeModal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { MobileGlassSurface } from './MobileGlass';
import {
    resolveAnchoredMenuPlacement,
} from './anchoredActionMenuPlacement';
import type { AnchoredMenuRect } from './anchoredActionMenuPlacement';

const MENU_WIDTH = 224;
const MENU_ITEM_HEIGHT = 44;
const MENU_SECTION_HEIGHT = 30;

export type AnchoredActionMenuItem = {
    id: string;
    kind?: 'item' | 'section';
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    disabled?: boolean;
    destructive?: boolean;
    selected?: boolean;
    onPress?: () => void;
};

export function AnchoredActionMenu(props: {
    anchor: AnchoredMenuRect | null;
    dismissLabel?: string;
    glassEnabled: boolean;
    items: readonly AnchoredActionMenuItem[];
    onClose: () => void;
    testID?: string;
    visible: boolean;
    preferAbove?: boolean;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const keyboard = useKeyboardState();
    const { height: viewportHeight, width: viewportWidth } = useWindowDimensions();
    const placement = React.useMemo(() => {
        if (!props.anchor) return null;
        return resolveAnchoredMenuPlacement({
            anchor: props.anchor,
            viewport: { width: viewportWidth, height: viewportHeight },
            menu: {
                width: MENU_WIDTH,
                height: props.items.reduce(
                    (height, item) => height + (item.kind === 'section' ? MENU_SECTION_HEIGHT : MENU_ITEM_HEIGHT),
                    0,
                ),
            },
            safeArea,
            keyboardHeight: keyboard.isVisible ? keyboard.height : 0,
            preferAbove: props.preferAbove,
        });
    }, [keyboard.height, keyboard.isVisible, props.anchor, props.items, props.preferAbove, safeArea, viewportHeight, viewportWidth]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.visible || typeof window === 'undefined') return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            props.onClose();
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [props.onClose, props.visible]);

    if (!props.visible || !placement) return null;

    return (
        <NativeModal
            animationType="none"
            onRequestClose={props.onClose}
            statusBarTranslucent
            transparent
            visible={props.visible}
        >
            <View style={styles.layer}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.dismissLabel ?? t('common.cancel')}
                    onPress={props.onClose}
                    style={styles.backdrop}
                    testID={props.testID ? `${props.testID}-dismiss` : undefined}
                />
                {placement.width > 0 && placement.height > 0 ? (
                    <View
                        accessibilityViewIsModal
                        style={[
                            styles.position,
                            {
                                left: placement.left,
                                top: placement.top,
                                width: placement.width,
                                height: placement.height,
                            },
                        ]}
                        testID={props.testID}
                    >
                        <MobileGlassSurface
                            enabled={props.glassEnabled}
                            nativeEffect
                            intensity={86}
                            style={styles.surface}
                        >
                            <ScrollView
                                bounces={false}
                                contentContainerStyle={styles.content}
                                keyboardShouldPersistTaps="handled"
                                showsVerticalScrollIndicator={false}
                                style={styles.menuScroll}
                            >
                                {props.items.map((item, index) => item.kind === 'section' ? (
                                    <View key={item.id} style={styles.section}>
                                        <Text style={styles.sectionLabel}>{item.label}</Text>
                                    </View>
                                ) : (
                                    <Pressable
                                        key={item.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={item.label}
                                        accessibilityState={{
                                            disabled: item.disabled,
                                            selected: item.selected,
                                        }}
                                        disabled={item.disabled}
                                        onPress={item.onPress}
                                        style={({ pressed }) => [
                                            styles.item,
                                            index < props.items.length - 1 && styles.itemDivider,
                                            pressed && !item.disabled && styles.itemPressed,
                                            item.disabled && styles.itemDisabled,
                                        ]}
                                        testID={props.testID ? `${props.testID}-${item.id}` : undefined}
                                    >
                                        {item.icon && (
                                            <Ionicons
                                                color={item.destructive ? theme.colors.warningCritical : theme.colors.text}
                                                name={item.icon}
                                                size={18}
                                            />
                                        )}
                                        <Text
                                            style={[
                                                styles.itemLabel,
                                                item.destructive && { color: theme.colors.warningCritical },
                                            ]}
                                        >
                                            {item.label}
                                        </Text>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        </MobileGlassSurface>
                    </View>
                ) : null}
            </View>
        </NativeModal>
    );
}

const styles = StyleSheet.create((theme) => ({
    layer: {
        flex: 1,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    position: {
        position: 'absolute',
    },
    surface: {
        flex: 1,
        overflow: 'hidden',
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowOffset: { width: 0, height: 3 },
        shadowRadius: 8,
        elevation: 6,
    },
    content: {
        flexGrow: 1,
    },
    menuScroll: {
        flex: 1,
    },
    item: {
        minHeight: MENU_ITEM_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 6,
    },
    section: {
        minHeight: MENU_SECTION_HEIGHT,
        justifyContent: 'flex-end',
        paddingHorizontal: 14,
        paddingTop: 8,
        paddingBottom: 4,
    },
    sectionLabel: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    itemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    itemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    itemDisabled: {
        opacity: 0.42,
    },
    itemLabel: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
}));
