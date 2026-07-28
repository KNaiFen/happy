import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import {
    getAllowInsecureHttp,
    getServerUrl,
    getServerInfo,
    setAllowInsecureHttp,
    setServerUrl,
    validateServerUrl,
    type ServerUrlValidation,
} from '@/sync/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isTauri } from '@/utils/isTauri';
import {
    commitServerTransportPolicy,
    probeServerHealth,
} from '@/sync/serverTransport';
import { apiSocket } from '@/sync/apiSocket';
import { ServerUrlPolicyError } from '@/sync/serverUrlPolicy';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: theme.colors.glass.backgroundSubtle }),
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [allowInsecureHttp, setAllowInsecureHttpState] = useState(getAllowInsecureHttp());
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const isBrowserWeb = Platform.OS === 'web' && !isTauri();

    const validateServer = async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);
            
            const response = await probeServerHealth(url, allowInsecureHttp);
            
            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            
            const health = await response.json() as {
                status?: string;
                service?: string;
            };
            if (health.status !== 'ok' || health.service !== 'happy-server') {
                setError(t('server.notValidHappyServer'));
                return false;
            }
            
            return true;
        } catch (err) {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl, { allowInsecureHttp });
        if (!validation.valid) {
            setError(serverUrlValidationMessage(validation));
            return;
        }

        // Validate the server
        const isValid = await validateServer(validation.normalizedUrl);
        if (!isValid) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );

        if (confirmed) {
            setServerUrl(validation.normalizedUrl);
            try {
                await commitServerTransportPolicy();
            } catch {
                setError(t('server.failedToConnectToServer'));
                return;
            }
            apiSocket.disconnect();
        }
    };

    const handleAllowInsecureHttpChange = async (value: boolean) => {
        if (!value) {
            setAllowInsecureHttp(false);
            setAllowInsecureHttpState(false);
            setError(null);
            try {
                await commitServerTransportPolicy();
            } catch (error) {
                if (!(error instanceof ServerUrlPolicyError)) {
                    setError(t('server.failedToConnectToServer'));
                    return;
                }
            }
            if (getServerUrl().startsWith('http://')) {
                apiSocket.disconnect();
            }
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.insecureHttpConfirmTitle'),
            t('server.insecureHttpConfirmBody'),
            {
                confirmText: t('server.enableInsecureHttp'),
                destructive: true,
            },
        );
        if (!confirmed) return;

        setAllowInsecureHttp(true);
        setAllowInsecureHttpState(true);
        setError(null);
        try {
            await commitServerTransportPolicy();
        } catch {
            setAllowInsecureHttp(false);
            setAllowInsecureHttpState(false);
            try {
                await commitServerTransportPolicy();
            } catch {
                // Preserve the original native policy commit failure.
            }
            setError(t('server.failedToConnectToServer'));
            return;
        }
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            setServerUrl(null);
            setAllowInsecureHttp(false);
            setAllowInsecureHttpState(false);
            setInputUrl('');
            try {
                await commitServerTransportPolicy();
            } catch {
                setError(t('server.failedToConnectToServer'));
                return;
            }
            apiSocket.disconnect();
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.serverConfiguration'),
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer={t('server.advancedFeatureFooter')}>
                        <Item
                            title={t('server.allowInsecureHttp')}
                            subtitle={isBrowserWeb
                                ? t('server.webHttpLocalhostOnly')
                                : t('server.allowInsecureHttpSubtitle')}
                            rightElement={
                                <Switch
                                    value={!isBrowserWeb && allowInsecureHttp}
                                    disabled={isBrowserWeb}
                                    onValueChange={(value) => {
                                        void handleAllowInsecureHttpChange(value);
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? t('server.validating') : t('common.save')}
                                        size="normal"
                                        action={handleSave}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                            {serverInfo.isCustom && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}

function serverUrlValidationMessage(validation: Exclude<ServerUrlValidation, { valid: true }>): string {
    switch (validation.errorCode) {
        case 'empty':
            return t('server.enterServerUrl');
        case 'invalidUrl':
            return t('errors.invalidFormat');
        case 'unsupportedProtocol':
            return t('server.httpOrHttpsOnly');
        case 'credentialsNotAllowed':
            return t('server.urlCredentialsNotAllowed');
        case 'queryNotAllowed':
            return t('server.urlQueryNotAllowed');
        case 'fragmentNotAllowed':
            return t('server.urlFragmentNotAllowed');
        case 'insecureHttpNotAllowed':
            return t('server.enableInsecureHttpFirst');
        case 'webHttpRequiresLoopback':
            return t('server.webHttpLocalhostOnly');
    }
}
