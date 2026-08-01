import React from 'react';
import { ActivityIndicator, View, Text, Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllMachines, useMachinesLoaded } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';
import { resolveEmptyMainScreenState } from './emptyMainScreenState';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 32,
    },
    title: {
        marginBottom: 16,
        textAlign: 'center',
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    terminalBlock: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surfaceHigh }),
        borderRadius: Platform.select({ web: 8, default: 12 }),
        padding: 20,
        marginHorizontal: 24,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 16,
        color: theme.colors.status.connected,
    },
    terminalTextFirst: {
        marginBottom: 8,
    },
    stepsContainer: {
        marginTop: 12,
        marginHorizontal: 24,
        marginBottom: 48,
        width: 250,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    stepRowLast: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    stepNumber: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.OS === 'web' ? 0 : 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    stepNumberText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    stepText: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
    },
    buttonsContainer: {
        alignItems: 'center',
        width: '100%',
    },
    buttonWrapper: {
        width: 240,
        marginBottom: 12,
    },
    buttonWrapperSecondary: {
        width: 240,
    },
    machineIcon: {
        marginBottom: 16,
    },
    machineName: {
        maxWidth: 280,
        marginBottom: 6,
        textAlign: 'center',
        fontSize: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    machineStatus: {
        marginBottom: 24,
        fontSize: 15,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    newSessionButton: {
        minHeight: 44,
        paddingHorizontal: 20,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: theme.colors.button.primary.background,
    },
    newSessionButtonDisabled: {
        opacity: 0.5,
    },
    newSessionButtonText: {
        fontSize: 16,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
    machineDetailsButton: {
        alignItems: 'center',
    },
}));

export function EmptyMainScreen() {
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();
    const machines = useAllMachines({ includeOffline: true });
    const machinesLoaded = useMachinesLoaded();
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const screenState = resolveEmptyMainScreenState(machinesLoaded, machines.length);
    const selectedMachine = machines.find(isMachineOnline) ?? machines[0] ?? null;
    const selectedMachineOnline = selectedMachine ? isMachineOnline(selectedMachine) : false;

    if (screenState === 'loading') {
        return (
            <View style={styles.container}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (screenState === 'start-session' && selectedMachine) {
        const machineName = selectedMachine.metadata?.host?.trim() || selectedMachine.id;
        return (
            <View style={styles.container}>
                <Pressable
                    testID="empty-main-machine-details"
                    accessibilityRole="button"
                    accessibilityLabel={machineName}
                    onPress={() => router.navigate(`/machine/${selectedMachine.id}` as any)}
                    style={({ pressed }) => [styles.machineDetailsButton, pressed ? { opacity: 0.72 } : null]}
                >
                    <Ionicons
                        name="desktop-outline"
                        size={56}
                        color={theme.colors.textSecondary}
                        style={styles.machineIcon}
                    />
                    <Text
                        testID="empty-main-machine-name"
                        style={styles.machineName}
                        numberOfLines={2}
                    >
                        {machineName}
                    </Text>
                    <Text style={styles.machineStatus}>
                        {selectedMachineOnline ? t('status.connected') : t('status.disconnected')}
                    </Text>
                </Pressable>
                <Pressable
                    testID="empty-main-new-session"
                    accessibilityRole="button"
                    accessibilityLabel={t('newSession.title')}
                    disabled={!selectedMachineOnline}
                    onPress={() => router.navigate('/new')}
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        !selectedMachineOnline && styles.newSessionButtonDisabled,
                        pressed && selectedMachineOnline ? { opacity: 0.82 } : null,
                    ]}
                >
                    <Ionicons
                        name="add"
                        size={20}
                        color={theme.colors.button.primary.tint}
                    />
                    <Text style={styles.newSessionButtonText}>{t('newSession.title')}</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View testID="empty-main-pair-machine" style={styles.container}>
            {/* Terminal-style code block */}
            <Text style={styles.title}>{t('components.emptyMainScreen.readyToCode')}</Text>
            <View style={styles.terminalBlock}>
                <Text style={[styles.terminalText, styles.terminalTextFirst]}>
                    $ npm i -g happy
                </Text>
                <Text style={styles.terminalText}>
                    $ happy
                </Text>
            </View>


            {Platform.OS !== 'web' && (
                <>
                    <View style={styles.stepsContainer}>
                        <View style={styles.stepRow}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>1</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.installCli')}
                            </Text>
                        </View>
                        <View style={styles.stepRow}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>2</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.runIt')}
                            </Text>
                        </View>
                        <View style={styles.stepRowLast}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>3</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.scanQrCode')}
                            </Text>
                        </View>
                    </View>
                    <View style={styles.buttonsContainer}>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={t('components.emptyMainScreen.openCamera')}
                                size="large"
                                loading={isLoading}
                                onPress={connectTerminal}
                            />
                        </View>
                        <View style={styles.buttonWrapperSecondary}>
                            <RoundButton
                                title={t('connect.enterUrlManually')}
                                size="normal"
                                display="inverted"
                                onPress={async () => {
                                    const url = await Modal.prompt(
                                        t('modals.authenticateTerminal'),
                                        t('modals.pasteUrlFromTerminal'),
                                        {
                                            placeholder: 'happy://terminal?...',
                                            cancelText: t('common.cancel'),
                                            confirmText: t('common.authenticate')
                                        }
                                    );

                                    if (url?.trim()) {
                                        connectWithUrl(url.trim());
                                    }
                                }}
                            />
                        </View>
                    </View>
                </>
            )}
        </View>
    );
}
