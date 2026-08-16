import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export type NativeSettingsMenuOption = {
    key: string;
    label: string;
    disabled?: boolean;
};

export type NativeSettingsMenuGroup = {
    key: string;
    label: string;
    systemImage?: string;
    options: NativeSettingsMenuOption[];
    selectedKey: string | null | undefined;
    onSelect: (key: string) => void;
    /** Keep the menu open after choosing an option in this group. */
    keepOpenOnSelect?: boolean;
};

export type NativeSettingsMenuProps = {
    groups: NativeSettingsMenuGroup[];
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    testID?: string;
    /** Render all options directly in the root menu instead of nesting by group. */
    flat?: boolean;
    /** Put the group owning the pressed trigger first in a shared menu. */
    preferredGroupKey?: string;
};

export { orderSettingsMenuGroups } from './settingsMenuPolicy';

const NativeSettingsMenuImpl = Platform.select<React.ComponentType<NativeSettingsMenuProps>>({
    ios: require('./NativeSettingsMenu.ios').NativeSettingsMenu,
    android: require('./NativeSettingsMenu.android').NativeSettingsMenu,
    default: require('./NativeSettingsMenu.web').NativeSettingsMenu,
}) ?? require('./NativeSettingsMenu.web').NativeSettingsMenu;

export function NativeSettingsMenu(props: NativeSettingsMenuProps) {
    return <NativeSettingsMenuImpl {...props} />;
}
