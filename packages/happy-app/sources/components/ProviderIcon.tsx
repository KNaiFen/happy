import * as React from 'react';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

const providerImages = {
    codex: require('@/assets/images/icon-gpt.png'),
} as const;

export function ProviderIcon({ kind, size = 14 }: { kind?: string | null; size?: number }) {
    const { theme } = useUnistyles();
    void kind;
    return (
        <Image
            source={providerImages.codex}
            style={{ width: size, height: size }}
            contentFit="contain"
            tintColor={theme.colors.textSecondary}
        />
    );
}
