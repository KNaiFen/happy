import * as React from 'react';
import { Keyboard, Platform } from 'react-native';

import { KeyboardDismissCoordinator } from '@/utils/keyboardDismissCoordinator';

export function useKeyboardDismissCoordinator<Key extends string>(): KeyboardDismissCoordinator<Key> {
    const coordinatorRef = React.useRef<KeyboardDismissCoordinator<Key> | null>(null);
    if (coordinatorRef.current === null) {
        coordinatorRef.current = new KeyboardDismissCoordinator<Key>({
            isWeb: () => Platform.OS === 'web',
            isVisible: () => Keyboard.isVisible(),
            addDidHideListener: (listener) => Keyboard.addListener('keyboardDidHide', listener),
            dismiss: () => Keyboard.dismiss(),
        });
    }
    React.useEffect(() => () => coordinatorRef.current?.dispose(), []);
    return coordinatorRef.current;
}
